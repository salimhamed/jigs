import { existsSync } from "node:fs";
import type { CleanupOutcome } from "../../workflow/runtime/cleanup.ts";
import {
  type ReleasePolicy,
  type ReleaseReport,
  releaseSchema,
} from "../../workflow/runtime/release.ts";
import { removeCodexRunState } from "../agents/harnesses/codex-home.ts";
import { removePiRunState } from "../agents/harnesses/pi-home.ts";
import type { RunMetadata } from "../runtime/run-context.ts";
import { removeRunDirectory, runDirectory } from "../runtime/run-directory/index.ts";
import { fetchOriginDefault } from "./create.ts";
import type { RegistrySql } from "./registry.ts";
import { deleteWorktree, listWorktreesForRun, setWorktreeState } from "./registry.ts";
import { registrySql } from "./sql.ts";
import {
  applyTeardown,
  countUnmergedCommits,
  decideTeardown,
  isWorktreeDirty,
} from "./teardown.ts";

/** Apply one resolved policy outcome. Callers own terminal/active synchronization. */
export async function releaseRunResources(
  policy: ReleasePolicy,
  metadata: RunMetadata,
  sql: RegistrySql = registrySql(),
  outcome: CleanupOutcome = "success",
): Promise<ReleaseReport> {
  releaseSchema.parse(policy);
  const action = outcome === "success" ? policy.onSuccess : policy.onFailure;
  const rows = await listWorktreesForRun(sql, metadata.workflowRunId);
  const report: ReleaseReport = {
    policy,
    worktrees: [],
    runDirectory: {
      path: runDirectory(metadata),
      removed: false,
      reason: `${outcome === "success" ? "onSuccess" : "onFailure"} policy keeps run resources`,
    },
  };
  const fetched = new Map<string, boolean>();
  for (const row of rows) {
    const resource: ReleaseReport["worktrees"][number] = {
      path: row.path,
      branch: row.branch,
      removed: false,
      localBranchDeleted: false,
      remoteBranchDeleted: false,
      unmergedCommits: null,
      reason: `${outcome === "success" ? "onSuccess" : "onFailure"} policy keeps run resources`,
    };
    report.worktrees.push(resource);
    if (action === "keep") continue;
    try {
      if (!fetched.has(row.repoDir)) {
        try {
          await fetchOriginDefault(row.repoDir);
          fetched.set(row.repoDir, true);
        } catch {
          fetched.set(row.repoDir, false);
        }
      }
      const unmerged = fetched.get(row.repoDir)
        ? await countUnmergedCommits(row.repoDir, row.branch)
        : null;
      resource.unmergedCommits = unmerged;
      const present = existsSync(row.path);
      const plan = decideTeardown({
        dirty: present && (await isWorktreeDirty(row.path)),
        unmergedCommits: unmerged,
      });
      if (row.state === "provision-failed" || plan.preserve !== null) {
        resource.reason =
          row.state === "provision-failed"
            ? "provisioning evidence kept for jigs resources prune"
            : "uncommitted work kept for jigs resources prune";
        if (plan.preserve !== null) await setWorktreeState(sql, row.path, plan.preserve);
        continue;
      }
      Object.assign(
        resource,
        await applyTeardown(plan, {
          repoDir: row.repoDir,
          worktreePath: row.path,
          branch: row.branch,
        }),
      );
      await deleteWorktree(sql, row.path);
      resource.removed = true;
      resource.reason =
        resource.localBranchDeleted && resource.remoteBranchDeleted
          ? "worktree and merged branches released"
          : unmerged === null
            ? "worktree released; branches kept because ancestry could not be verified"
            : unmerged > 0
              ? `worktree released; branches kept with ${unmerged} unmerged commit(s)`
              : "worktree released; any remaining branch was absent, changed, or could not be deleted";
    } catch (error) {
      resource.reason = `release incomplete; inspect with pnpm exec jigs resources list before pnpm exec jigs resources prune: ${String(error)}`;
    }
  }
  if (action === "release") {
    await removeRunDirectory(metadata);
    report.runDirectory = {
      path: runDirectory(metadata),
      removed: true,
      reason: `${outcome} run directory released`,
    };
    if (report.worktrees.every((resource) => resource.removed)) {
      removeCodexRunState(metadata.workflowRunId);
      removePiRunState(metadata.workflowRunId);
    }
  }
  return report;
}
