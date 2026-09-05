import type { BindingClone } from "jigs";
import type { ISql } from "postgres";

export interface RegistryGateDeps {
  sql?: () => ISql | null;
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
    // Opening the connection belongs inside the try: a malformed
    // WORKFLOW_POSTGRES_URL makes postgres() throw synchronously, and that
    // escape is the very thing this gate exists to stop.
    const resolveSql =
      deps.sql ?? (await import("../src/worktrees/sql")).registrySql;
    const sql = resolveSql();
    if (sql === null) {
      log("[service] worktree registry skipped: WORKFLOW_POSTGRES_URL unset");
      return true;
    }
    const ensure =
      deps.ensure ??
      (await import("../src/worktrees/registry")).ensureWorktreeRegistry;
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
      const { factoryRoot } = await import("../src/preflight");
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

// The documented defineNitroPlugin subpath doesn't exist at nitro 3.0.260610-beta;
// a plain default export works.
export default async function startWorld() {
  // Before the World starts polling: the queue's very first step dispatch has
  // to go out on the scoped dispatcher, not node's five-minute default.
  const { describeStepCeiling, raiseStepCeiling } = await import(
    "../src/step-ceiling"
  );
  raiseStepCeiling();
  console.log(`[service] step ceiling: ${describeStepCeiling()}`);

  // Also before the World starts: a run that asks for a worktree against an
  // unusable registry has already burned an agent.
  if (!(await gateOnWorktreeRegistry())) return;

  // And before it too: a binding whose clone does not exist yet fails every
  // run that names it, so the fetch happens once, here, where it is a startup
  // cost rather than an agent's.
  if (!(await gateOnBindingClones())) return;

  const { getWorld } = await import("workflow/runtime");
  await getWorld().start?.();
  // Startup reconciliation of suspended runs (poke every held hook) would
  // live here; fast-follow — `jigs poke <run>` covers the gap for now.
  console.log(
    `[service] world started: ${process.env.WORKFLOW_TARGET_WORLD ?? "local (default)"}`,
  );

  // No background sweep: a run that finishes cleanly tears itself down, and
  // everything else stays on disk, visible in `jigs ps`, until the operator
  // reclaims it through `jigs sweep` — nothing deletes behind their back.
}
