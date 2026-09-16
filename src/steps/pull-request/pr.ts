// The pull-request side of the review loop's step surface: thin
// implementations over the GitHub provider, which the factory wraps as steps
// and injects. This module reaches the network, so it is only ever imported
// from inside a step body — the errors these raise workflow-side live in the
// factory's own composition, never here.

import { isPullRequestMergeReady } from "../../blocks/pull-request/merge-ready.ts";
import { resolveBinding } from "../../config/factory-config.ts";
import { factoryRoot } from "../../config/factory-root.ts";
import {
  createPullRequest,
  fetchPrSnapshot,
  fetchPrTitle,
  type PrRef,
  postPrComment,
  replyToReviewThread,
  squashMergePr,
} from "../../providers/github.ts";
import { type GithubRepoRef, parseGithubRemote } from "../../providers/github-webhook.ts";

// The binding is the remote now, so this is a config read: no git subprocess.
/** Find the GitHub repository configured for a binding. */
export async function resolveRepository(binding: string): Promise<GithubRepoRef> {
  const { remote } = resolveBinding(factoryRoot(), binding);
  const ref = parseGithubRemote(remote);
  if (ref === null) {
    throw new Error(
      `binding ${binding} points at ${remote}, which is not a github.com remote — the review loop opens its pull requests on GitHub`,
    );
  }
  return ref;
}

/** Open a pull request from the working branch into the base branch. */
export async function openPullRequest(
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
  return { owner: repo.owner, repo: repo.repo, number };
}

// A plain POST: the body already carries the marker that says what it answers,
// so nothing here reads or writes progress. The posted id is returned for a
// caller that wants to name it in a log.
/** Reply to a review thread and return the posted comment id. */
export async function replyToPullRequestReviewThread(
  pr: PrRef,
  rootId: number,
  body: string,
): Promise<{ id: number }> {
  return replyToReviewThread(pr, rootId, body);
}

/** Post a comment on the pull request conversation and return its id. */
export async function commentOnPullRequest(pr: PrRef, body: string): Promise<{ id: number }> {
  return postPrComment(pr, body);
}

// The subject is read here rather than carried in from `describePullRequest`: a
// reviewer who corrects the title — to satisfy a conventional-commit check on
// the target repo, usually — does it between the PR opening and this merge,
// and a title captured at open time would ship the one they corrected away.
/** Squash and merge the pull request using its current title. */
export async function squashMergePullRequest(
  pr: PrRef,
  expectedHeadSha?: string,
): Promise<{ merged: boolean; sha: string }> {
  if (expectedHeadSha !== undefined) {
    const snapshot = await fetchPrSnapshot(pr);
    if (snapshot.headSha !== expectedHeadSha || !isPullRequestMergeReady(snapshot)) {
      return { merged: false, sha: snapshot.headSha };
    }
  }
  const title = await fetchPrTitle(pr);
  return squashMergePr(pr, title, expectedHeadSha);
}
