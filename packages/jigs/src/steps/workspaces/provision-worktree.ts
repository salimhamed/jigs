// The step side of the worktree lifecycle: what the factory's "use step"
// wrappers delegate to. Provisioning records the worktree under the same
// run-scoped lock release and prune take. A suspended run keeps its worktree.
//
// Everything below reaches node builtins, so this module must only ever be
// imported from inside a step body. `WorktreeRequest` is a type, so a
// type-only import of it from workflow/ is erased and stays safe.

import { pathToFileURL } from "node:url";
import { resolveBinding } from "../../config/factory-config.ts";
import { currentFactoryContext } from "../../config/factory-context.ts";
import { JigsError } from "../../errors.ts";
import { isForkPullRequest } from "../../providers/github.ts";
import type { Binding } from "../../workflow/factory-schema.ts";
import { bindingRepository } from "../../workflow/github-remote.ts";
import type { PullRequestWorktree, Worktree } from "../../workflow/workspaces/worktree.ts";
import {
  recordResource,
  registrySql,
  setResourceState,
  withCloneLock,
  withRunResourceLock,
} from "../runtime/registry.ts";
import type { RunMetadata } from "../runtime/run-context.ts";
import { ensureBindingClone } from "./clone.ts";
import { createWorktree, detachedWorktree, fetchPullRequestHead, findWorktree } from "./create.ts";
import { type CloneDirOptions, cloneRepoDir, worktreePath } from "./layout.ts";
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

/**
 * The binding and pull request used to provision a worktree at the pull request's head.
 *
 * @group Worktrees
 */
export interface PullRequestWorktreeRequest {
  /** The binding whose repository the pull request is on. */
  binding: string;
  /** The pull request's number. */
  number: number;
}

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
  return provisionRecorded(request.binding, runId, async (binding, repoDir, dirs) => {
    const branch = runBranch(request.branch, runId);
    const cut = { repoDir, worktreePath: worktreePath({ ...dirs, branch }), branch };
    const facts: Worktree = {
      binding: binding.name,
      installationName: binding.installationName,
      ...((await findWorktree(cut)) ?? (await createWorktree(cut))),
    };
    return { facts, branch: facts.branch };
  });
}

/**
 * Check out a pull request's current head in a worktree of its own, and prepare its files and
 * dependencies.
 *
 * @remarks
 * Only a pull request from a branch of the binding's own repository is checked out, never one
 * from a fork, because the binding's setup runs the pull request's code. The worktree has no
 * branch, so nothing in it is pushed. Each head gets its own worktree, so a
 * run that provisions again after a push gets the new head beside the old one. Pass the returned
 * `headSha` to `mergePullRequest` to merge only the commit that was checked.
 *
 * @group Worktrees
 */
export async function provisionPullRequestWorktree(
  request: PullRequestWorktreeRequest,
  metadata: RunMetadata,
): Promise<PullRequestWorktree> {
  const runId = metadata.workflowRunId;
  return provisionRecorded(request.binding, runId, async (binding, repoDir, dirs) => {
    // Setup runs the checked-out code with the service's whole environment, so
    // a stranger's fork must never reach it.
    const repository = bindingRepository(binding.remote);
    const { installationName } = binding;
    if (await isForkPullRequest({ installationName, ...repository, number: request.number })) {
      throw new JigsError(
        `pull request #${request.number} on binding ${binding.name} is not a branch of ${binding.remote}`,
        "only a pull request from a branch of the binding's own GitHub repository can be checked out, because setup runs its code",
      );
    }
    const headSha = await fetchPullRequestHead(repoDir, request.number, runId);
    const name = runBranch(`pull-${request.number}-${headSha.slice(0, 12)}`, runId);
    const target = worktreePath({ ...dirs, branch: name });
    await detachedWorktree(repoDir, target, headSha);
    const facts: PullRequestWorktree = {
      binding: binding.name,
      installationName: binding.installationName,
      path: target,
      headSha,
    };
    return { facts, branch: null };
  });
}

async function provisionRecorded<T extends { path: string }>(
  bindingName: string,
  runId: string,
  cut: (
    binding: Binding,
    repoDir: string,
    dirs: CloneDirOptions,
  ) => Promise<{ facts: T; branch: string | null }>,
): Promise<T> {
  const ctx = currentFactoryContext();
  const sql = registrySql();

  return withRunResourceLock(sql, runId, async (lockedSql) => {
    const binding = resolveBinding(ctx.config, bindingName);
    const dirs = { factoryRoot: ctx.root, bindingName: binding.name };
    const repoDir = cloneRepoDir(dirs);
    const { owner, repo } = bindingRepository(binding.remote);
    await withCloneLock(lockedSql, repoDir, () =>
      ensureBindingClone({
        repoDir,
        url: `https://github.com/${owner}/${repo}.git`,
        installationName: binding.installationName,
      }),
    );

    // The run-scoped lock also belongs to release. It stays held through
    // recording and provisioning so release cannot remove a tree between its
    // creation and the end of this active step.
    const { facts, branch } = await cut(binding, repoDir, dirs);

    const own = { factory: ctx.slug, runId, kind: "worktree", identity: facts.path };
    await recordResource(lockedSql, {
      ...own,
      url: pathToFileURL(facts.path).href,
      repoDir,
      branch,
      binding: binding.name,
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
      `[worktree] provisioned binding=${binding.name} ${branch === null ? "detached" : `branch=${branch}`} path=${facts.path}`,
    );
    return facts;
  });
}
