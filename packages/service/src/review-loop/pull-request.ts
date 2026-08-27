// The review loop's step layer: thin "use step" wrappers over the GitHub
// provider and jigs' git helpers. jigs is imported dynamically inside the git
// steps — it reaches node builtins, which the workflow bundle must never see.

import type { GithubRepoRef } from "jigs";
import {
  createPullRequest,
  postPrComment,
  replyToReviewThread,
  squashMergePr,
} from "../providers/github";
import type { PrRef } from "../suspension/tokens";

export class RemoteNotGithubError extends Error {
  constructor(binding: string, url: string) {
    super(
      `binding ${binding} points at ${url}, which is not a github.com remote — the review loop opens its pull requests on GitHub`,
    );
    this.name = "RemoteNotGithubError";
  }
}

export class EmptyBranchError extends Error {
  constructor(branch: string, baseSha: string) {
    super(
      `${branch} holds no commits since ${baseSha} — the builder finished without committing, so there is nothing to open a pull request for`,
    );
    this.name = "EmptyBranchError";
  }
}

export async function resolveRepo(binding: string): Promise<GithubRepoRef> {
  "use step";
  const { parseGithubRemote, resolveBinding, resolveRemoteUrl } = await import(
    "jigs"
  );
  const { factoryRoot } = await import("../worktrees/request");
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
): Promise<{ commits: number; headSha: string }> {
  "use step";
  const { commitsAhead, headSha, pushBranch } = await import("jigs");
  const commits = await commitsAhead(worktreePath, baseSha);
  if (commits > 0) await pushBranch(worktreePath, branch);
  const head = await headSha(worktreePath);
  console.log(
    `[reviewLoop] pushed ${branch} commits=${commits} head=${head.slice(0, 8)}`,
  );
  return { commits, headSha: head };
}

export async function readDiff(
  worktreePath: string,
  baseSha: string,
): Promise<string> {
  "use step";
  const { diffSince } = await import("jigs");
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
  "use step";
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

export async function replyInThread(
  pr: PrRef,
  rootId: number,
  body: string,
): Promise<void> {
  "use step";
  await replyToReviewThread(pr, rootId, body);
  console.log(`[reviewLoop] replied in thread ${rootId} on #${pr.number}`);
}

export async function commentOnPr(pr: PrRef, body: string): Promise<void> {
  "use step";
  await postPrComment(pr, body);
  console.log(`[reviewLoop] commented on #${pr.number}`);
}

export async function squashMerge(
  pr: PrRef,
  title: string,
): Promise<{ merged: boolean; sha: string }> {
  "use step";
  const result = await squashMergePr(pr, title);
  console.log(
    `[reviewLoop] squash-merged #${pr.number} merged=${result.merged} sha=${result.sha}`,
  );
  return result;
}
