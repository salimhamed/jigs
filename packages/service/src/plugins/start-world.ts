import type { BindingClone } from "jigs";
import type { ISql } from "postgres";
import { READY_PHASE, setBootPhase } from "../readiness";
import { installShutdown, onShutdown, startOwningSignals } from "../shutdown";

export interface RegistryGateDeps {
  sql?: () => ISql;
  ensure?: (sql: ISql) => Promise<void>;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

// Nitro runs its plugins without awaiting them and only console.errors an
// unhandled rejection, so a throw out of here would leave the service up with
// the World already polling against a registry it cannot use. Exiting is the
// point; the boolean is for an injected exit that returns.
export async function gateOnWorktreeRegistry(
  deps: RegistryGateDeps = {},
): Promise<boolean> {
  const log = deps.log ?? ((line: string) => console.log(line));
  try {
    // Opening the connection belongs inside the try: a missing or malformed
    // WORKFLOW_POSTGRES_URL throws synchronously, and that escape is the very
    // thing this gate exists to stop.
    const resolveSql =
      deps.sql ?? (await import("../worktrees/sql")).registrySql;
    const sql = resolveSql();
    const ensure =
      deps.ensure ??
      (await import("../worktrees/registry")).ensureWorktreeRegistry;
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
export async function gateOnBindingClones(
  deps: BindingCloneGateDeps = {},
): Promise<boolean> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const exit = deps.exit ?? process.exit;

  let declared: BindingClone[];
  let ensure: (options: { repoDir: string; remote: string }) => Promise<void>;
  try {
    // Inside the try: reading the factory config is itself fallible, and a
    // service that cannot tell what is bound must not start.
    const jigs = await import("jigs");
    ensure = deps.ensure ?? jigs.ensureBindingClone;
    if (deps.bindings !== undefined) {
      declared = deps.bindings();
    } else {
      const { factoryRoot } = await import("../preflight");
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
    log(
      `[service] binding ${binding.name}: ensuring clone at ${binding.repoDir}`,
    );
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

export interface WorldStartGateDeps {
  start: () => Promise<void>;
  exit?: (code: number) => void;
  error?: (line: string) => void;
}

// Like the other gates: a World that cannot start — a WORKFLOW_TARGET_WORLD
// that does not resolve, a migration missing, a database gone since the
// registry gate — would otherwise be a console.error from nitro and a process
// that stays up with `ready` never true, so `jigs service start` waits out its
// whole budget on it.
export async function gateOnWorldStart(
  deps: WorldStartGateDeps,
): Promise<boolean> {
  try {
    await deps.start();
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

  // Before the World starts polling: the queue's very first step dispatch has
  // to go out on the scoped dispatcher, not node's five-minute default.
  const { describeStepCeiling, raiseStepCeiling } = await import(
    "../step-ceiling"
  );
  raiseStepCeiling();
  console.log(`[service] step ceiling: ${describeStepCeiling()}`);

  // Also before the World starts: a run that asks for a worktree against an
  // unusable registry has already burned an agent.
  setBootPhase("registry");
  if (!(await gateOnWorktreeRegistry())) return;

  // And before it too: a binding whose clone does not exist yet fails every
  // run that names it, so the fetch happens once, here, where it is a startup
  // cost rather than an agent's.
  if (!(await gateOnBindingClones())) return;

  const { getWorld } = await import("workflow/runtime");
  // The service owns its exit: on SIGTERM `world.close()` drains the queue
  // and ends the pool, and the process leaves once that is done. The World's
  // start is where graphile-worker would install handlers of its own, so it
  // runs stripped of them — see startOwningSignals.
  setBootPhase("world");
  onShutdown(() => getWorld().close?.());
  const started = await gateOnWorldStart({
    start: () =>
      startOwningSignals(async () => {
        await getWorld().start?.();
      }),
  });
  if (!started) return;
  // Startup reconciliation of suspended runs (poke every held hook) would
  // live here; fast-follow — `jigs poke <run>` covers the gap for now.
  console.log(
    `[service] world started: ${process.env.WORKFLOW_TARGET_WORLD ?? "local (default)"}`,
  );
  setBootPhase(READY_PHASE);

  // No background sweep: a run that finishes cleanly tears itself down, and
  // everything else stays on disk, visible in `jigs ps`, until the operator
  // reclaims it through `jigs sweep` — nothing deletes behind their back.
}
