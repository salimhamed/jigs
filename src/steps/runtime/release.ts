import { getWorld } from "workflow/runtime";
import type { ReleasePolicy, ReleaseReport } from "../../workflow/runtime/release.ts";
import { resourcesFromAttributes } from "../../workflow/runtime/resources.ts";
import { withRunResourceLock } from "../workspaces/registry.ts";
import { releaseRunResources as applyRelease } from "../workspaces/release.ts";
import { registrySql } from "../workspaces/sql.ts";
import { writeCleanupDirective, writeCleanupProgress } from "./cleanup-state.ts";
import type { RunMetadata } from "./run-context.ts";

/** Persist an explicit success action, release under the run lock and return the result. */
export async function releaseRunResources(
  policy: ReleasePolicy,
  metadata: RunMetadata,
): Promise<ReleaseReport> {
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
