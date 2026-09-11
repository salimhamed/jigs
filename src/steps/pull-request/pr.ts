// The pull-request side of the review loop's step surface: thin
// implementations over the GitHub provider, which the factory wraps as steps
// and injects. This module reaches the network, so it is only ever imported
// from inside a step body — the errors these raise workflow-side live in the
// factory's own composition, never here.

import { resolveBinding } from "../../config/factory-config.ts";
import { factoryRoot } from "../../config/factory-root.ts";
import {
  createPullRequest,
  fetchPrTitle,
  type PrRef,
  postPrComment,
  replyToReviewThread,
  squashMergePr,
} from "../../providers/github.ts";
import {
  type GithubRepoRef,
  parseGithubRemote,
} from "../../providers/github-webhook.ts";

// The binding is the remote now, so this is a config read: no git subprocess.
export async function resolveRepo(binding: string): Promise<GithubRepoRef> {
  const { remote } = resolveBinding(factoryRoot(), binding);
  const ref = parseGithubRemote(remote);
  if (ref === null) {
    throw new Error(
      `binding ${binding} points at ${remote}, which is not a github.com remote — the review loop opens its pull requests on GitHub`,
    );
  }
  return ref;
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
  return { owner: repo.owner, repo: repo.repo, number };
}

// The posted id is returned rather than dropped: the gate cursor needs the ids
// of jigs' own replies to tell its last word on a thread from a human's, which
// author identity cannot do on a personal-token factory.
export async function replyInThread(
  pr: PrRef,
  rootId: number,
  body: string,
): Promise<{ id: number }> {
  return replyToReviewThread(pr, rootId, body);
}

export async function commentOnPr(pr: PrRef, body: string): Promise<void> {
  await postPrComment(pr, body);
}

// The subject is read here rather than carried in from `describePr`: a
// reviewer who corrects the title — to satisfy a conventional-commit check on
// the target repo, usually — does it between the PR opening and this merge,
// and a title captured at open time would ship the one they corrected away.
export async function squashMerge(
  pr: PrRef,
): Promise<{ merged: boolean; sha: string }> {
  const title = await fetchPrTitle(pr);
  return squashMergePr(pr, title);
}
