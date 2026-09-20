// The step side of the worktree lifecycle: what the factory's "use step"
// wrappers delegate to. The runtime creates and registers worktrees; explicit
// and automatic release share the run-scoped lock below. A suspended run keeps
// its worktree, and safety-kept work remains available to resource inventory.
//
// Everything below reaches node builtins, so this module must only ever be
// imported from inside a step body. `WorktreeRequest` is a type, so a
// workflow-side `import type` of it is erased and stays safe.

import type { Worktree } from "../../blocks/workspaces/worktree.ts";
import { resolveBinding } from "../../config/factory-config.ts";
import { factoryRoot } from "../../config/factory-root.ts";
import { JigsError } from "../../errors.ts";
import type { RunMetadata } from "../runtime/run-context.ts";
import { hasBindingClone } from "./clone.ts";
import { createWorktree, worktreeStatus } from "./create.ts";
import { bindingRepoDir, worktreePath } from "./layout.ts";
import { type OwnerState, readOwner } from "./owner.ts";
import { provisionWorktree as provisionWorktreeFiles } from "./provision.ts";
import type { RegistrySql } from "./registry.ts";
import { getWorktree, setWorktreeState, upsertWorktree, withRunResourceLock } from "./registry.ts";
import { assertReusable, WorktreeOwnedError } from "./reuse.ts";
import { registrySql } from "./sql.ts";

export interface WorktreeRequest {
  binding: string;
  branch: string;
}

// `sql` and `readOwner` wrap the two external systems this path consults —
// the registry and the World — and nothing else here is an option.
export interface ProvisionWorktreeDependencies {
  sql?: RegistrySql;
  readOwner?: (runId: string) => Promise<OwnerState>;
  withLock?: <T>(runId: string, action: (sql: RegistrySql) => Promise<T>) => Promise<T>;
}

// The clone is the service's to make at start, so this path only asserts it.
/** Create or reuse a worktree for this run and prepare its files and dependencies. */
export async function provisionWorktree(
  request: WorktreeRequest,
  metadata: RunMetadata,
  deps: ProvisionWorktreeDependencies = {},
): Promise<Worktree> {
  const runId = metadata.workflowRunId;
  const sql = deps.sql ?? registrySql();
  const owner = deps.readOwner ?? readOwner;
  const lock =
    deps.withLock ?? ((ownerRunId, action) => withRunResourceLock(sql, ownerRunId, action));

  return lock(runId, async (lockedSql) => {
    const binding = resolveBinding(factoryRoot(), request.binding);
    const dirs = { factoryRoot: factoryRoot(), bindingName: binding.name };
    const repoDir = bindingRepoDir(dirs);
    const target = worktreePath({ ...dirs, branch: request.branch });

    // Only reachable when the binding was declared after this service booted:
    // both the reuse check and the cut read a clone that is not there.
    if (!hasBindingClone(repoDir)) {
      throw new JigsError(
        `binding ${binding.name} has no clone at ${repoDir}`,
        "restart the service: jigs service restart (it clones every binding on start)",
      );
    }

    // The run-scoped lock also belongs to automatic cleanup. It stays held
    // through registry registration and provisioning so cleanup cannot remove
    // a tree between its creation and the end of this active step.
    const row = await getWorktree(lockedSql, target);
    const sameOwner = row?.ownerRunId === runId;
    // Refuse before touching disk: worktreeStatus fetches, and a foreign live
    // owner should never surface as a network error or pay for the fetch.
    if (row !== null && !sameOwner && !(await owner(row.ownerRunId)).terminal) {
      throw new WorktreeOwnedError(target, row.ownerRunId);
    }

    const cut = { repoDir, worktreePath: target, branch: request.branch };
    const disk = await worktreeStatus(cut);
    // A registry row with no directory is just a branch with no worktree —
    // fall through to three-way resolution.
    if (disk !== null) assertReusable({ path: target, sameOwner, disk });
    const facts: Worktree =
      disk === null
        ? await createWorktree(cut)
        : {
            path: target,
            branch: request.branch,
            defaultBranch: disk.defaultBranch,
            baseSha: disk.baseSha,
          };

    await upsertWorktree(lockedSql, {
      path: facts.path,
      branch: facts.branch,
      ownerRunId: runId,
      state: "active",
      repoDir,
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
      await setWorktreeState(lockedSql, facts.path, "provision-failed");
      throw err;
    }
    console.log(
      `[worktree] provisioned binding=${binding.name} branch=${facts.branch} path=${facts.path}`,
    );
    return facts;
  });
}

export { releaseRunResources } from "./release.ts";
