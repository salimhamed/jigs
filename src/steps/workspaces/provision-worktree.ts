// The step side of the worktree lifecycle: what the factory's "use step"
// wrappers delegate to. Provisioning records the worktree under the same
// run-scoped lock release and prune take. A suspended run keeps its worktree.
//
// Everything below reaches node builtins, so this module must only ever be
// imported from inside a step body. `WorktreeRequest` is a type, so a
// type-only import of it from workflow/ is erased and stays safe.

import { pathToFileURL } from "node:url";
import { getRun } from "workflow/api";
import { resolveBinding } from "../../config/factory-config.ts";
import { factoryRoot } from "../../config/factory-root.ts";
import { JigsError } from "../../errors.ts";
import { TERMINAL_RUN_STATUSES } from "../../run-status.ts";
import { UNRELEASED_STATES } from "../../workflow/runtime/resources.ts";
import type { Worktree } from "../../workflow/workspaces/worktree.ts";
import {
  alsoLockRun,
  currentFactory,
  listResources,
  type RegistrySql,
  recordResource,
  registrySql,
  setResourceState,
  withRunResourceLock,
} from "../runtime/registry.ts";
import type { RunMetadata } from "../runtime/run-context.ts";
import { hasBindingClone } from "./clone.ts";
import { createWorktree, worktreeStatus } from "./create.ts";
import { cloneRepoDir, worktreePath } from "./layout.ts";
import { provisionWorktree as provisionWorktreeFiles } from "./provision.ts";
import { assertReusable, WorktreeOwnedError } from "./reuse.ts";

/**
 * The binding and branch used to provision a run's worktree.
 *
 * @group Worktrees
 */
export interface WorktreeRequest {
  binding: string;
  branch: string;
}

// `sql` and `runStatus` wrap the two external systems this path consults —
// the registry and the World — and nothing else here is an option.
/**
 * Injectable registry and ownership operations used while provisioning a worktree.
 *
 * @group Advanced implementation/testing
 */
export interface ProvisionWorktreeDependencies {
  sql?: RegistrySql;
  /** The World's status for a run, or null when it has no such run. */
  runStatus?: (runId: string) => Promise<string | null>;
  withLock?: <T>(runId: string, action: (sql: RegistrySql) => Promise<T>) => Promise<T>;
}

// The clone is the service's to make at start, so this path only asserts it.
/**
 * Create or reuse a worktree for this run and prepare its files and dependencies.
 *
 * @group Worktrees
 */
export async function provisionWorktree(
  request: WorktreeRequest,
  metadata: RunMetadata,
  deps: ProvisionWorktreeDependencies = {},
): Promise<Worktree> {
  const runId = metadata.workflowRunId;
  const sql = deps.sql ?? registrySql();
  const runStatus =
    deps.runStatus ??
    (async (id: string) => {
      const run = getRun(id);
      return (await run.exists) ? await run.status : null;
    });
  const lock =
    deps.withLock ?? ((ownerRunId, action) => withRunResourceLock(sql, ownerRunId, action));

  return lock(runId, async (lockedSql) => {
    const binding = resolveBinding(factoryRoot(), request.binding);
    const dirs = { factoryRoot: factoryRoot(), bindingName: binding.name };
    const repoDir = cloneRepoDir(dirs);
    const target = worktreePath({ ...dirs, branch: request.branch });

    // Only reachable when the binding was declared after this service booted:
    // both the reuse check and the cut read a clone that is not there.
    if (!hasBindingClone(repoDir)) {
      throw new JigsError(
        `binding ${binding.name} has no clone at ${repoDir}`,
        "restart the service: pnpm exec jigs service restart (it clones every binding on start)",
      );
    }

    // The run-scoped lock also belongs to release. It stays held through
    // recording and provisioning so release cannot remove a tree between its
    // creation and the end of this active step.
    const factory = currentFactory();
    const holders = await listResources(lockedSql, {
      factory,
      kind: "worktree",
      identity: target,
      states: UNRELEASED_STATES,
    });
    const sameOwner = holders.some((holder) => holder.runId === runId);
    const others = holders.filter((holder) => holder.runId !== runId);
    // Refuse before touching disk: worktreeStatus fetches, and a foreign live
    // owner should never surface as a network error or pay for the fetch. A
    // run the World no longer knows is as finished as one that completed.
    // Its lock keeps a release of that finished run already under way from
    // racing this read of the disk; a finished run never waits on this one.
    for (const other of others) {
      const status = await runStatus(other.runId);
      if (status !== null && !TERMINAL_RUN_STATUSES.has(status)) {
        throw new WorktreeOwnedError(target, other.runId);
      }
      await alsoLockRun(lockedSql, other.runId);
    }

    const cut = { repoDir, worktreePath: target, branch: request.branch };
    const disk = await worktreeStatus(cut);
    // A registry row with no directory is just a branch with no worktree —
    // fall through to three-way resolution.
    if (disk !== null) assertReusable({ path: target, sameOwner, disk });
    const facts: Worktree =
      disk === null
        ? { binding: binding.name, ...(await createWorktree(cut)) }
        : {
            binding: binding.name,
            path: target,
            branch: request.branch,
            defaultBranch: disk.defaultBranch,
            baseSha: disk.baseSha,
          };

    const own = { factory, runId, kind: "worktree", identity: facts.path };
    await recordResource(lockedSql, {
      ...own,
      url: pathToFileURL(facts.path).href,
      repoDir,
      branch: facts.branch,
    });
    // The finished owner's record would otherwise let its release delete this run's tree.
    for (const other of others) {
      await setResourceState(lockedSql, other, "released", `reused by run ${runId}`);
    }

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
