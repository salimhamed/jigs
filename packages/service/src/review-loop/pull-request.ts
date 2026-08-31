// The step side of the review loop: thin implementations over the GitHub
// provider and jigs' git helpers, which the factory wraps as steps and injects.
// jigs reaches node builtins, so this module must only ever be imported from
// inside a step body — hence its errors thrown workflow-side live in ./loop.

import {
  commitsAhead,
  diffSince,
  type GithubRepoRef,
  headSha,
  isWorktreeDirty,
  parseGithubRemote,
  pushBranch,
  resolveBinding,
  resolveRemoteUrl,
} from "jigs";
import {
  createPullRequest,
  fetchPrTitle,
  postPrComment,
  replyToReviewThread,
  squashMergePr,
} from "../providers/github";
import type { PrRef } from "../suspension/tokens";
import { factoryRoot } from "../worktrees/request";

export class RemoteNotGithubError extends Error {
  constructor(binding: string, url: string) {
    super(
      `binding ${binding} points at ${url}, which is not a github.com remote — the review loop opens its pull requests on GitHub`,
    );
    this.name = "RemoteNotGithubError";
  }
}

export async function resolveRepo(binding: string): Promise<GithubRepoRef> {
  const resolved = resolveBinding(factoryRoot(), binding);
  const { url } = await resolveRemoteUrl(resolved.checkoutRoot);
  const ref = parseGithubRemote(url);
  if (ref === null) throw new RemoteNotGithubError(binding, url);
  console.log(
    `[reviewLoop] binding ${binding} resolves to ${ref.owner}/${ref.repo}`,
  );
  return ref;
}

export async function pushWorktreeBranch(
  worktreePath: string,
  branch: string,
  baseSha: string,
): Promise<{ commits: number; headSha: string; dirty: boolean }> {
  const commits = await commitsAhead(worktreePath, baseSha);
  if (commits > 0) await pushBranch(worktreePath, branch);
  const head = await headSha(worktreePath);
  // Reported alongside the commit count because the two together are what tell
  // an empty push apart: no commits and a clean tree is a builder that did
  // nothing, no commits and a dirty tree is work that can still be saved.
  const dirty = await isWorktreeDirty(worktreePath);
  console.log(
    `[reviewLoop] pushed ${branch} commits=${commits} head=${head.slice(0, 8)} dirty=${dirty}`,
  );
  return { commits, headSha: head, dirty };
}

export async function readDiff(
  worktreePath: string,
  baseSha: string,
): Promise<string> {
  const diff = await diffSince(worktreePath, baseSha);
  console.log(`[reviewLoop] read diff since ${baseSha} chars=${diff.length}`);
  return diff;
}

export async function openPr(
  repo: GithubRepoRef,
  head: string,
  base: string,
  title: string,
  body: string,
): Promise<PrRef> {
  const { number } = await createPullRequest({
    owner: repo.owner,
    repo: repo.repo,
    head,
    base,
    title,
    body,
  });
  console.log(`[reviewLoop] opened PR ${repo.owner}/${repo.repo}#${number}`);
  return { owner: repo.owner, repo: repo.repo, number };
}

// The posted id is returned rather than dropped: the gate cursor needs the ids
// of jigs' own replies to tell its last word on a thread from a human's, which
// author identity cannot do on a personal-token factory (AGE-363).
export async function replyInThread(
  pr: PrRef,
  rootId: number,
  body: string,
): Promise<{ id: number }> {
  const posted = await replyToReviewThread(pr, rootId, body);
  console.log(
    `[reviewLoop] replied in thread ${rootId} on #${pr.number} as comment ${posted.id}`,
  );
  return posted;
}

export async function commentOnPr(pr: PrRef, body: string): Promise<void> {
  await postPrComment(pr, body);
  console.log(`[reviewLoop] commented on #${pr.number}`);
}

// The subject is read here rather than carried in from `describePr`: a
// reviewer who corrects the title — to satisfy a conventional-commit check on
// the target repo, usually — does it between the PR opening and this merge,
// and a title captured at open time would ship the one they corrected away.
export async function squashMerge(
  pr: PrRef,
): Promise<{ merged: boolean; sha: string }> {
  const title = await fetchPrTitle(pr);
  const result = await squashMergePr(pr, title);
  console.log(
    `[reviewLoop] squash-merged #${pr.number} as "${title}" merged=${result.merged} sha=${result.sha}`,
  );
  return result;
}
