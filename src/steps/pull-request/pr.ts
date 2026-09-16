// The pull-request side of the review loop's step surface: thin
// implementations over the GitHub provider, which the factory wraps as steps
// and injects. This module reaches the network, so it is only ever imported
// from inside a step body — the errors these raise workflow-side live in the
// factory's own composition, never here.

import { type MergeRefusal, mergeRefusal } from "../../blocks/pull-request/merge-ready.ts";
import {
  type MergePolicy,
  readFactoryConfig,
  resolveBinding,
} from "../../config/factory-config.ts";
import { factoryRoot } from "../../config/factory-root.ts";
import {
  assignPullRequest,
  createPullRequest,
  fetchPrCommitMessages,
  fetchPrSnapshot,
  fetchPrTitle,
  mergePr,
  type PrRef,
  postPrComment,
  replyToReviewThread,
} from "../../providers/github.ts";
import { GithubApiError } from "../../providers/github-api.ts";
import { resolveGithubIdentity } from "../../providers/github-auth.ts";
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

/** Read this factory's merge policy, optionally overriding who merges. */
export async function resolveMergePolicy(by?: MergePolicy["by"]): Promise<MergePolicy> {
  const { merge } = readFactoryConfig(factoryRoot());
  return by === undefined ? merge : { ...merge, by };
}

/** Open a pull request from the working branch into the base branch. */
export async function openPullRequest(
  repo: GithubRepoRef,
  head: string,
  base: string,
  title: string,
  body: string,
): Promise<PrRef> {
  const identity = resolveGithubIdentity();
  // In App mode the pull request's author is the bot, which is what lets the
  // operator approve it. The assignee and the opening line are how the
  // operator still shows up on it — GitHub has no second author field.
  const operator = identity.mode === "app" ? identity.operator : null;
  const { number } = await createPullRequest({
    owner: repo.owner,
    repo: repo.repo,
    head,
    base,
    title,
    body: operator === null ? body : `Requested by @${operator}.\n\n${body}`,
  });
  const pr = { owner: repo.owner, repo: repo.repo, number };
  if (operator !== null) await assignPullRequest(pr, [operator]);
  return pr;
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

/**
 * What GitHub did, and when it did not, why — and whether asking again could
 * change the answer, which is what decides between standing the commit down
 * and leaving it merge-ready.
 */
export type MergeOutcome =
  // `null` when GitHub has not reported the commit yet, which a re-read after
  // an ambiguous answer can leave open.
  { merged: true; mergeCommitSha: string | null } | ({ merged: false } & MergeRefusal);

// GitHub answers 405 for a merge it cannot perform and 409 for a head that
// moved under the pinned sha. Neither is a failure of jigs and neither is
// success: the pull request changed, so the next wake reads it and decides
// again.
const STATE_CHANGED = new Set([405, 409]);

/**
 * Merge the pull request with the configured method, pinned to the head the
 * caller judged ready.
 *
 * The title is re-read here rather than carried in from `describePullRequest`:
 * a reviewer who corrects it — to satisfy a conventional-commit check on the
 * target repo, usually — does so between the pull request opening and this
 * merge, and a title captured at open time would ship the one they corrected
 * away. After any ambiguous answer the pull request is read again, and this
 * reports `merged` only if GitHub says so.
 */
export async function mergePullRequest(
  pr: PrRef,
  expectedHeadSha: string,
  policy: MergePolicy,
): Promise<MergeOutcome> {
  const before = await fetchPrSnapshot(pr);
  if (before.merged) return { merged: true, mergeCommitSha: before.mergeCommitSha };
  const refusal = mergeRefusal(before, expectedHeadSha, policy.approval);
  if (refusal !== null) return { merged: false, ...refusal };
  const message = await mergeCommitBody(pr, policy.method);
  try {
    const result = await mergePr(pr, {
      title: await fetchPrTitle(pr),
      expectedHeadSha,
      method: policy.method,
      ...(message === undefined ? {} : { message }),
    });
    if (result.merged) return { merged: true, mergeCommitSha: result.sha };
  } catch (error) {
    if (!(error instanceof GithubApiError) || !STATE_CHANGED.has(error.status)) throw error;
    console.log(
      `[merge] ${pr.owner}/${pr.repo}#${pr.number} refused with ${error.status}: ${error.body}`,
    );
  }
  // Ambiguous either way: GitHub is the only authority on whether it merged.
  const after = await fetchPrSnapshot(pr);
  if (after.merged) return { merged: true, mergeCommitSha: after.mergeCommitSha };
  // A snapshot that still reads mergeable after GitHub refused the merge is
  // one no later wake will read differently: the configured method is disabled
  // on the repository, or a protection GitHub does not express in
  // `mergeable_state` stopped it. Retrying that on every nudge would never end.
  return {
    merged: false,
    ...(mergeRefusal(after, expectedHeadSha, policy.approval) ?? {
      reason: `GitHub refused to merge ${expectedHeadSha} and still reports it as ${after.mergeState}`,
      transient: false,
    }),
  };
}

/**
 * The merge commit body, or nothing at all.
 *
 * GitHub makes a squash commit's author the pull request's author, which in App
 * mode is the bot, so the `Co-authored-by` trailer is how the operator keeps the
 * credit. Sending `commit_message` *replaces* the body GitHub would have
 * written, and that body is the branch's own commit messages — which carry the
 * `BREAKING CHANGE:` footers release-please reads
 * ([ADR 0014](../../../docs/adr/0014-release-automation.md)). So the trailer is
 * appended to a reconstruction of that body rather than sent instead of it, and
 * with no co-author configured nothing is sent and GitHub's own body stands.
 * A rebase rewrites the branch's commits and has no merge message at all.
 */
async function mergeCommitBody(
  pr: PrRef,
  method: MergePolicy["method"],
): Promise<undefined | string> {
  const identity = resolveGithubIdentity();
  if (method === "rebase" || identity.mode !== "app" || identity.coAuthor === undefined) {
    return undefined;
  }
  const body = defaultMergeBody(await fetchPrCommitMessages(pr));
  const trailer = `Co-authored-by: ${identity.coAuthor}`;
  return body === "" ? trailer : `${body}\n\n${trailer}`;
}

// What GitHub composes when no `commit_message` is sent: one commit's own body
// verbatim, or a bulleted list of the messages when the branch carries several.
export function defaultMergeBody(messages: string[]): string {
  const only = messages.length === 1 ? messages[0] : undefined;
  if (only !== undefined) return only.split("\n").slice(1).join("\n").trim();
  return messages
    .map((message) => {
      const [subject = "", ...rest] = message.split("\n");
      const body = rest.join("\n").trim();
      return body === "" ? `* ${subject}` : `* ${subject}\n\n${body}`;
    })
    .join("\n\n");
}
