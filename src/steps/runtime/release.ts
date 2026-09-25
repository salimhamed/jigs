import { getWorld } from "workflow/runtime";
import type { FactoryDefinition } from "../../workflow/factory.ts";
import type { ReleasePolicy, ReleaseReport } from "../../workflow/runtime/release.ts";
import { resourcesFromAttributes } from "../../workflow/runtime/resources.ts";
import { withRunResourceLock } from "../workspaces/registry.ts";
import { releaseRunResources as applyRelease } from "../workspaces/release.ts";
import { registrySql } from "../workspaces/sql.ts";
import { writeCleanupDirective, writeCleanupProgress } from "./cleanup-state.ts";
import { resolveReleasePolicy } from "./release-policy.ts";
import type { NamedRunMetadata } from "./run-context.ts";

/**
 * Release this run's resources on its success path and return what was removed or kept.
 *
 * @remarks
 * Without a policy, uses the workflow's `release`, then the factory's, then the default of
 * releasing successful runs and keeping failed ones. The success action is recorded first, so
 * automatic cleanup after the run ends never reverses it.
 *
 * @group Release
 */
export async function releaseRunResources(
  metadata: NamedRunMetadata,
  definition: FactoryDefinition,
  explicit?: ReleasePolicy,
): Promise<ReleaseReport> {
  const policy = explicit ?? (await resolveReleasePolicy(metadata, definition));
  const action = policy.onSuccess;
  await writeCleanupDirective(metadata.workflowRunId, action);
  await writeCleanupProgress(metadata.workflowRunId, {
    status: "pending",
    outcome: "success",
    action,
  });
  const sql = registrySql();
  return withRunResourceLock(sql, metadata.workflowRunId, async (lockedSql) => {
    await writeCleanupProgress(metadata.workflowRunId, {
      status: "running",
      outcome: "success",
      action,
    });
    const report = await applyRelease(policy, metadata, lockedSql, "success");
    const run = await (await getWorld()).runs.get(metadata.workflowRunId, { resolveData: "none" });
    const resources = resourcesFromAttributes(run.attributes);
    const failed = report.worktrees.filter((resource) =>
      resource.reason.startsWith("release incomplete"),
    ).length;
    const released =
      report.worktrees.filter((resource) => resource.removed).length +
      (report.runDirectory.removed ? 1 : 0);
    const kept =
      report.worktrees.length - failed - report.worktrees.filter((r) => r.removed).length;
    await writeCleanupProgress(metadata.workflowRunId, {
      status: failed > 0 ? "failed" : action === "keep" ? "kept" : "complete",
      outcome: "success",
      action,
      released,
      kept,
      failed,
      unknown: resources.filter(
        (resource) => resource.kind !== "worktree" && resource.kind !== "run-directory",
      ).length,
    });
    return report;
  });
}
