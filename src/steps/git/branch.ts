import {
  commitsAhead,
  DEFAULT_PUSH_TARGET,
  diffSince,
  git,
  pushBranch as gitPushBranch,
  headSha,
  type PushTarget,
  pushCommit,
  resolveRemoteUrl,
  tryGit,
} from "../../providers/git.ts";
import { githubAuthFor } from "../../providers/github-auth.ts";
import { parseGithubRemote } from "../../providers/github-webhook.ts";
import { registerResource } from "../runtime/resources.ts";
import { isWorktreeDirty } from "../workspaces/teardown.ts";

// A binding's remote is an SSH URL, which authenticates as whoever owns the
// key on this machine — the operator. An installation token cannot travel that
// way, so App mode pushes to the same repository over HTTPS and hands the token
// to `PushTarget`, which keeps it out of the URL and out of argv. Only the push
// is redirected: the binding's clone and every fetch still use its own remote,
// as the operator.
async function pushTarget(worktreePath: string): Promise<PushTarget> {
  const { url } = await resolveRemoteUrl(worktreePath);
  const ref = parseGithubRemote(url);
  const auth = githubAuthFor(ref?.owner ?? "");
  if (auth.identity.mode === "pat") return DEFAULT_PUSH_TARGET;
  if (ref === null) {
    throw new Error(
      `${worktreePath} pushes to ${url}, which is not a github.com remote — a GitHub App installation token can only push to GitHub`,
    );
  }
  return {
    remote: `https://github.com/${ref.owner}/${ref.repo}.git`,
    token: await auth.bearer(),
  };
}

async function registerGithubBranch(worktreePath: string, branch: string): Promise<void> {
  const { url } = await resolveRemoteUrl(worktreePath);
  const ref = parseGithubRemote(url);
  if (ref === null) return;
  await registerResource({
    kind: "branch",
    identity: `${ref.owner}/${ref.repo}:${branch}`,
    url: `https://github.com/${ref.owner}/${ref.repo}/tree/${encodeURIComponent(branch)}`,
  });
}

/** Inspect the worktree state used to decide whether a branch is ready to push. */
export async function readBranchState(
  worktreePath: string,
  baseSha: string,
): Promise<{
  /** The number of commits reachable from HEAD but not the base commit. */
  commits: number;
  /** The current HEAD commit SHA. */
  headSha: string;
  /** Whether the worktree has uncommitted changes or its status could not be read. */
  dirty: boolean;
}> {
  const commits = await commitsAhead(worktreePath, baseSha);
  const head = await headSha(worktreePath);
  const dirty = await isWorktreeDirty(worktreePath);
  return { commits, headSha: head, dirty };
}

/**
 * Whether `sha` is the worktree's HEAD or one of its ancestors. A commit the worktree has never
 * fetched is not contained.
 */
export async function branchContains(worktreePath: string, sha: string): Promise<boolean> {
  return (await tryGit(["merge-base", "--is-ancestor", sha, "HEAD"], worktreePath)) !== null;
}

/** Push the worktree's current HEAD and register a GitHub branch resource when applicable. */
export async function pushBranch(
  worktreePath: string,
  branch: string,
): Promise<{
  /** The worktree's HEAD commit after the push succeeds. */
  headSha: string;
}> {
  await gitPushBranch(worktreePath, branch, await pushTarget(worktreePath));
  await registerGithubBranch(worktreePath, branch);
  return { headSha: await headSha(worktreePath) };
}

/**
 * Push a reviewed commit only while it is still HEAD and the worktree is clean.
 *
 * Safe to retry after a successful push. Rejects if HEAD moved or any uncommitted change exists.
 */
export async function pushApprovedChange(
  worktreePath: string,
  branch: string,
  approvedCommit: string,
): Promise<{
  /** The approved commit SHA that was pushed. */
  headSha: string;
}> {
  const head = await headSha(worktreePath);
  const status = await git(["status", "--porcelain"], worktreePath);
  if (status !== "") {
    throw new Error(
      `Cannot publish ${branch}: the worktree has uncommitted changes that no review approved`,
    );
  }
  if (head !== approvedCommit) {
    throw new Error(
      `Cannot publish ${branch}: ${head} is not the approved commit ${approvedCommit}`,
    );
  }
  await pushCommit(worktreePath, branch, approvedCommit, await pushTarget(worktreePath));
  await registerGithubBranch(worktreePath, branch);
  return { headSha: approvedCommit };
}

/** Read a raw patch from the merge base of `baseSha` and HEAD, truncating after 200,000 characters. */
export async function readWorktreeDiff(worktreePath: string, baseSha: string): Promise<string> {
  return diffSince(worktreePath, baseSha);
}
