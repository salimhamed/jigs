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

  // No background sweep: a run that finishes cleanly tears itself down, and
  // everything else stays on disk, visible in `jigs ps`, until the operator
  // reclaims it through `jigs sweep` — nothing deletes behind their back.
}
