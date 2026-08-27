// The documented defineNitroPlugin subpath doesn't exist at nitro 3.0.260610-beta;
// a plain default export works.
export default async function startWorld() {
  const { getWorld } = await import("workflow/runtime");
  await getWorld().start?.();
  // Startup reconciliation of suspended runs (poke every held hook) would
  // live here; fast-follow — `jigs poke <run>` covers the gap for now.
  console.log(
    `[service] world started: ${process.env.WORKFLOW_TARGET_WORLD ?? "local (default)"}`,
  );

  const { registrySql } = await import("../src/worktrees/sql");
  const sql = registrySql();
  if (sql === null) {
    console.log(
      "[service] worktree registry skipped: WORKFLOW_POSTGRES_URL unset",
    );
    return;
  }
  const { ensureWorktreeRegistry } = await import("../src/worktrees/registry");
  await ensureWorktreeRegistry(sql);
  console.log("[service] worktree registry ensured");

  // Teardown's trigger: the SDK has no run-completion callback, so the
  // terminal-state join runs on a timer. It is the same pass `jigs sweep`
  // calls, so the matrix has exactly one implementation — minus the
  // unregistered-directory scan, which only a human should ever act on.
  const { sweepWorktrees } = await import("../src/worktrees/sweep");
  let inFlight = false;
  const pass = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await sweepWorktrees(
        { clean: true, includeUnregistered: false },
        { sql },
      );
    } finally {
      inFlight = false;
    }
  };
  await pass().catch(console.error);

  const intervalMs = Number(process.env.JIGS_SWEEP_INTERVAL_MS ?? 60_000);
  if (intervalMs > 0) {
    setInterval(() => {
      pass().catch(console.error);
    }, intervalMs).unref();
  }
}
