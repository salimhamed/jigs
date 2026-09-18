// The branch side of the review loop's step surface: what the worktree's
// commits look like, and getting them onto the remote. Reaches node builtins
// through jigs' git helpers, so it is only ever imported from a step body.

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
} from "../../providers/git.ts";
import { githubAuth } from "../../providers/github-auth.ts";
import { parseGithubRemote } from "../../providers/github-webhook.ts";
import { isWorktreeDirty } from "../workspaces/teardown.ts";

// A binding's remote is an SSH URL, which authenticates as whoever owns the
// key on this machine — the operator. An installation token cannot travel that
// way, so App mode pushes to the same repository over HTTPS and hands the token
// to `PushTarget`, which keeps it out of the URL and out of argv. Only the push
// is redirected: the binding's clone and every fetch still use its own remote,
// as the operator.
async function pushTarget(worktreePath: string): Promise<PushTarget> {
  const auth = githubAuth();
  if (auth.identity.mode === "pat") return DEFAULT_PUSH_TARGET;
  const { url } = await resolveRemoteUrl(worktreePath);
  const ref = parseGithubRemote(url);
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

// Three reads and no side effect, so a caller can ask what is on the branch
// before deciding whether to push. Only committed work is ever reviewed or
// published, so a dirty tree is a terminal stop whatever the commit count
// says, and the head sha is what publication holds the approved commit to.
/** Check for new commits and uncommitted changes before pushing a branch. */
export async function readBranchState(
  worktreePath: string,
  baseSha: string,
): Promise<{ commits: number; headSha: string; dirty: boolean }> {
  const commits = await commitsAhead(worktreePath, baseSha);
  const head = await headSha(worktreePath);
  const dirty = await isWorktreeDirty(worktreePath);
  return { commits, headSha: head, dirty };
}

// Pushes unconditionally: a push with nothing new is a successful no-op, and
// the caller that cares asks readBranchState first.
/** Push the worktree branch to its remote. */
export async function pushBranch(
  worktreePath: string,
  branch: string,
): Promise<{ headSha: string }> {
  await gitPushBranch(worktreePath, branch, await pushTarget(worktreePath));
  return { headSha: await headSha(worktreePath) };
}

/** Recheck approval on every attempt and push only the reviewed commit. */
export async function pushApprovedChange(
  worktreePath: string,
  branch: string,
  approvedCommit: string,
): Promise<{ headSha: string }> {
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
  return { headSha: approvedCommit };
}

/** Read committed changes since the base commit. Large diffs are truncated. */
export async function readWorktreeDiff(worktreePath: string, baseSha: string): Promise<string> {
  return diffSince(worktreePath, baseSha);
}
