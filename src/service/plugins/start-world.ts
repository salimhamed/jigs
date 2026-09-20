import type { World } from "@workflow/world";
import { WorkflowRunNotFoundError } from "workflow/errors";
import type { HarnessKind, HarnessRuntime } from "../../checks/harness-runtime.ts";
import { TERMINAL_RUN_STATUSES } from "../../run-status.ts";
import type { BindingClone } from "../../steps/workspaces/clone.ts";
import type { RegistrySql } from "../../steps/workspaces/registry.ts";
import { READY_PHASE, setBootPhase } from "../readiness.ts";
import { installShutdown, onShutdown } from "../shutdown.ts";

// Why every import below is dynamic: this module's top level has to stay free
// of postgres, the factory config and the workflow runtime — the gate tests
// import these functions directly, and a static import would stand all three
// up to do it. Inside the plugin the deferral also orders the boot: nothing
// fallible resolves until installShutdown() can turn its failure into an exit.

// Both, because the service hosts every workflow the factory declares.
const HARNESSES: HarnessKind[] = ["claude", "codex"];

export interface HarnessRuntimeGateDeps {
  runtimes?: () => Promise<HarnessRuntime[]>;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

// Without this, a missing or too-old CLI is found by the first agent step of
// the first run, long after the queue, the preflight and a worktree.
export async function gateOnHarnessRuntimes(deps: HarnessRuntimeGateDeps = {}): Promise<boolean> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const resolve =
    deps.runtimes ??
    (async () => (await import("../../checks/harness-runtime.ts")).harnessRuntimes(HARNESSES));

  let runtimes: HarnessRuntime[];
  try {
    runtimes = await resolve();
  } catch (err) {
    (deps.error ?? ((line: string) => console.error(line)))(
      `[service] could not check the harness CLIs: ${describe(err)}`,
    );
    (deps.exit ?? process.exit)(1);
    return false;
  }

  const failures = runtimes.filter((runtime) => !runtime.ok);
  const [first] = failures;
  if (first !== undefined && first.ok === false) {
    const error = deps.error ?? ((line: string) => console.error(line));
    error(
      `[service] cannot run agents: ${failures.map((runtime) => runtime.line).join("; ")}. The ${first.repair}`,
    );
    (deps.exit ?? process.exit)(1);
    return false;
  }
  for (const runtime of runtimes) log(`[service] harness ${runtime.line}`);
  return true;
}

export interface RegistryGateDeps {
  sql?: () => RegistrySql;
  ensure?: (sql: RegistrySql) => Promise<void>;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

// Nitro runs its plugins without awaiting them and only console.errors an
// unhandled rejection, so a throw out of here would leave the service up with
// the World already polling against a registry it cannot use. Exiting is the
// point; the boolean is for an injected exit that returns.
export async function gateOnWorktreeRegistry(deps: RegistryGateDeps = {}): Promise<boolean> {
  const log = deps.log ?? ((line: string) => console.log(line));
  try {
    // Opening the connection belongs inside the try: a missing or malformed
    // WORKFLOW_POSTGRES_URL throws synchronously, and that escape is the very
    // thing this gate exists to stop.
    const resolveSql = deps.sql ?? (await import("../../steps/workspaces/sql.ts")).registrySql;
    const sql = resolveSql();
    const ensure =
      deps.ensure ?? (await import("../../steps/workspaces/registry.ts")).ensureWorktreeRegistry;
    await ensure(sql);
  } catch (err) {
    const error = deps.error ?? ((line: string) => console.error(line));
    error(
      `[service] worktree registry unusable: ${err instanceof Error ? err.message : String(err)}`,
    );
    (deps.exit ?? process.exit)(1);
    return false;
  }
  log("[service] worktree registry ensured");
  return true;
}

export interface BindingCloneGateDeps {
  bindings?: () => BindingClone[];
  ensure?: (options: { repoDir: string; remote: string }) => Promise<void>;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const hint = (err as { hint?: string }).hint;
    return hint === undefined ? err.message : `${err.message} — ${hint}`;
  }
  return String(err);
}

// Cloning at start rather than when a run asks for a worktree is what keeps a
// minute of `git fetch` out of that run, and puts a remote jigs cannot reach
// in front of the operator at start instead of mid-agent.
export async function gateOnBindingClones(deps: BindingCloneGateDeps = {}): Promise<boolean> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const exit = deps.exit ?? process.exit;

  let declared: BindingClone[];
  let ensure: (options: { repoDir: string; remote: string }) => Promise<void>;
  try {
    // Inside the try: reading the factory config is itself fallible, and a
    // service that cannot tell what is bound must not start.
    const jigs = await import("../../steps/workspaces/clone.ts");
    ensure = deps.ensure ?? jigs.ensureBindingClone;
    if (deps.bindings !== undefined) {
      declared = deps.bindings();
    } else {
      const { factoryRoot } = await import("../../config/factory-root.ts");
      declared = jigs.bindingClones(factoryRoot());
    }
  } catch (err) {
    error(`[service] bindings unreadable: ${describe(err)}`);
    exit(1);
    return false;
  }

  for (const binding of declared) {
    // Before, not after: a first fetch of a large repo holds the boot for
    // minutes, and this line is the only thing that says which one.
    setBootPhase(`cloning ${binding.name}`);
    log(`[service] binding ${binding.name}: ensuring clone at ${binding.repoDir}`);
    try {
      await ensure({ repoDir: binding.repoDir, remote: binding.remote });
    } catch (err) {
      error(`[service] binding ${binding.name}: ${describe(err)}`);
      exit(1);
      return false;
    }
  }
  return true;
}

interface ServiceWorld {
  createQueueHandler?: World["createQueueHandler"];
  runs?: World["runs"];
  start?: () => Promise<void>;
  close?: () => Promise<void>;
}

const TERMINAL_FENCE = Symbol("jigs.terminal-delivery-fence");

type FencedWorld = ServiceWorld & { [TERMINAL_FENCE]?: boolean };

// Workflow v5 turbo starts an attempt-1 step body before its backgrounded
// run_started write confirms that the run is still live. A delivery held in a
// real queue can therefore be cancelled before its first attempt and still run
// that body. Fence at the World's public handler seam: terminal deliveries are
// acknowledged without entering the generated runtime, while a delivery that
// was live when handling began keeps the SDK's documented active-work behavior.
export function fenceTerminalWorkflowDeliveries(world: ServiceWorld): void {
  const fenced = world as FencedWorld;
  if (fenced[TERMINAL_FENCE]) return;
  const createQueueHandler = world.createQueueHandler;
  const getRun = world.runs?.get;
  if (createQueueHandler === undefined || getRun === undefined) return;

  world.createQueueHandler = (prefix, handler) =>
    createQueueHandler.call(world, prefix, async (message, metadata) => {
      if (isHealthCheckDelivery(message)) return handler(message, metadata);
      const runId = deliveryRunId(message);
      if (runId !== null) {
        try {
          const run = await getRun.call(world.runs, runId);
          if (TERMINAL_RUN_STATUSES.has(run.status)) return;
        } catch (error) {
          // The SDK owns missing-run semantics: runInput may resiliently create
          // the run, while an ordinary invocation produces its normal missing-
          // run rejection and telemetry. Only unrelated status-read failures
          // stay at this seam so Graphile retries without executing the handler.
          if (!WorkflowRunNotFoundError.is(error)) throw error;
        }
      }
      return handler(message, metadata);
    });
  fenced[TERMINAL_FENCE] = true;
}

function deliveryRunId(message: unknown): string | null {
  if (typeof message !== "object" || message === null || !("runId" in message)) return null;
  return typeof message.runId === "string" ? message.runId : null;
}

// Mirrors the SDK's public HealthCheckPayload shape. A cross-deployment start
// includes the future runId so its target can derive the run's public key
// before run creation; that id must never turn the probe into a status lookup.
// Keep this structural: @workflow/world is a type-only dependency of this
// package, while factories supply workflow and their concrete World at runtime.
function isHealthCheckDelivery(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  if (!("__healthCheck" in message) || message.__healthCheck !== true) return false;
  if (!("correlationId" in message) || typeof message.correlationId !== "string") return false;
  return !("runId" in message) || message.runId === undefined || typeof message.runId === "string";
}

export interface WorldStartGateDeps {
  getWorld: () => Promise<ServiceWorld>;
  own: (world: ServiceWorld) => void;
  exit?: (code: number) => void;
  error?: (line: string) => void;
}

// Like the other gates: a World that cannot start — a WORKFLOW_TARGET_WORLD
// that does not resolve, a migration missing, a database gone since the
// registry gate — would otherwise be a console.error from nitro and a process
// that stays up with `ready` never true, so `jigs service start` waits out its
// whole budget on it.
export async function gateOnWorldStart(deps: WorldStartGateDeps): Promise<boolean> {
  try {
    const world = await deps.getWorld();
    fenceTerminalWorkflowDeliveries(world);
    deps.own(world);
    await world.start?.();
  } catch (err) {
    const error = deps.error ?? ((line: string) => console.error(line));
    error(`[service] world failed to start: ${describe(err)}`);
    (deps.exit ?? process.exit)(1);
    return false;
  }
  return true;
}

// The documented defineNitroPlugin subpath doesn't exist at nitro 3.0.260610-beta;
// a plain default export works.
export default async function startWorld() {
  // First of all, ahead of any gate that can hold the boot: a `jigs service
  // stop` during a first clone or against a hanging Postgres has to end in an
  // exit, not the CLI's SIGKILL. A clone child mid-gate is orphaned to
  // completion; acceptable.
  installShutdown();

  // First, because it is local and fast: no point cloning for a service that
  // cannot run an agent.
  setBootPhase("harnesses");
  if (!(await gateOnHarnessRuntimes())) return;

  // Also before the World starts: a run that asks for a worktree against an
  // unusable registry has already burned an agent.
  setBootPhase("registry");
  if (!(await gateOnWorktreeRegistry())) return;

  // And before it too: a binding whose clone does not exist yet fails every
  // run that names it, so the fetch happens once, here, where it is a startup
  // cost rather than an agent's.
  if (!(await gateOnBindingClones())) return;

  // The service owns its exit: on SIGTERM `world.close()` drains the queue
  // and ends the pool, and the process leaves once that is done. Tell the
  // Postgres World not to install Graphile's competing signal handlers before
  // the SDK resolves and caches it. Other World implementations ignore this.
  process.env.WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN ??= "1";
  setBootPhase("world");
  const started = await gateOnWorldStart({
    getWorld: async () => {
      const { getWorld } = await import("workflow/runtime");
      return getWorld();
    },
    own: (world) => onShutdown(() => world.close?.()),
  });
  if (!started) return;
  console.log(`[service] world started: ${process.env.WORKFLOW_TARGET_WORLD ?? "local (default)"}`);

  setBootPhase(READY_PHASE);

  // Startup reconciliation, then the floor under the webhook: every parked
  // pull request is re-read now, in case a delivery was lost while the service
  // was down, and every five minutes after that. After readiness, not before:
  // a slow pull-request nudge pass must not hold `jigs service start` on a
  // service that is already answering.
  const { nudgePullRequests, startPullRequestNudge } = await import("../nudge.ts");
  const nudge = startPullRequestNudge();
  onShutdown(() => {
    nudge.stop();
  });
  await nudgePullRequests();

  // The generated factory plugin starts automatic release after this plugin
  // reaches readiness. It imports the compiled factory so per-workflow policy
  // stays available to the coordinator.
}
