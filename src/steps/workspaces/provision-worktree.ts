// The step side of the worktree lifecycle: what the factory's "use step"
// wrappers delegate to. Provisioning records the worktree under the same
// run-scoped lock release and prune take. A suspended run keeps its worktree.
//
// Everything below reaches node builtins, so this module must only ever be
// imported from inside a step body. `WorktreeRequest` is a type, so a
// type-only import of it from workflow/ is erased and stays safe.

import { pathToFileURL } from "node:url";
import { resolveBinding } from "../../config/factory-config.ts";
import { factoryRoot } from "../../config/factory-root.ts";
import { JigsError } from "../../errors.ts";
import type { Worktree } from "../../workflow/workspaces/worktree.ts";
import {
  currentFactory,
  recordResource,
  registrySql,
  setResourceState,
  withRunResourceLock,
} from "../runtime/registry.ts";
import type { RunMetadata } from "../runtime/run-context.ts";
import { hasBindingClone } from "./clone.ts";
import { createWorktree, findWorktree } from "./create.ts";
import { cloneRepoDir, worktreePath } from "./layout.ts";
import { provisionWorktree as provisionWorktreeFiles } from "./provision.ts";

/**
 * The binding and branch used to provision a run's worktree.
 *
 * @group Worktrees
 */
export interface WorktreeRequest {
  binding: string;
  /** The branch name to start from; the run's own branch adds a suffix from its run ID. */
  branch: string;
}

// Deterministic, so a retry of the run's own step lands on the same branch and
// path, while every other run gets its own.
const runBranch = (branch: string, runId: string): string =>
  `${branch}-${runId.slice(-6).toLowerCase()}`;

// The clone is the service's to make at start, so this path only asserts it.
/**
 * Create this run's own branch and worktree from the default branch, and prepare its files and
 * dependencies.
 *
 * @remarks
 * Every run gets a new branch, so a run never picks up another run's work. The returned
 * `branch` is the one to push and open a pull request from.
 *
 * @group Worktrees
 */
export async function provisionWorktree(
  request: WorktreeRequest,
  metadata: RunMetadata,
): Promise<Worktree> {
  const runId = metadata.workflowRunId;
  const sql = registrySql();

  return withRunResourceLock(sql, runId, async (lockedSql) => {
    const binding = resolveBinding(factoryRoot(), request.binding);
    const dirs = { factoryRoot: factoryRoot(), bindingName: binding.name };
    const repoDir = cloneRepoDir(dirs);
    const branch = runBranch(request.branch, runId);
    const target = worktreePath({ ...dirs, branch });

    // Only reachable when the binding was declared after this service booted.
    if (!hasBindingClone(repoDir)) {
      throw new JigsError(
        `binding ${binding.name} has no clone at ${repoDir}`,
        "restart the service: pnpm exec jigs service restart (it clones every binding on start)",
      );
    }

    // The run-scoped lock also belongs to release. It stays held through
    // recording and provisioning so release cannot remove a tree between its
    // creation and the end of this active step.
    const cut = { repoDir, worktreePath: target, branch };
    const facts: Worktree = {
      binding: binding.name,
      ...((await findWorktree(cut)) ?? (await createWorktree(cut))),
    };

    const own = { factory: currentFactory(), runId, kind: "worktree", identity: facts.path };
    await recordResource(lockedSql, {
      ...own,
      url: pathToFileURL(facts.path).href,
      repoDir,
      branch: facts.branch,
    });

    try {
      await provisionWorktreeFiles({
        binding,
        factoryRoot: dirs.factoryRoot,
        worktreePath: facts.path,
      });
    } catch (err) {
      // The half-provisioned tree stays on disk, marked for diagnosis: an agent
      // building in it would produce expensive garbage.
      await setResourceState(lockedSql, own, "kept", "provisioning failed; kept for diagnosis");
      throw err;
    }
    console.log(
      `[worktree] provisioned binding=${binding.name} branch=${facts.branch} path=${facts.path}`,
    );
    return facts;
  });
}
