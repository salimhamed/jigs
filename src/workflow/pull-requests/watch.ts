import { createHook } from "workflow";
import { ClaimConflictError } from "../linear/claim.ts";
import { type FetchPrState, type PullRequestRef, pullRequestToken } from "./gate.ts";
import type { PullRequestSnapshot } from "./snapshot.ts";

// Snapshot arrays are collections, not sequences: API ordering alone is not new activity.
// Sort object keys too so injected readers need not preserve insertion order. The fingerprint
// is captured before yielding, so a consumer cannot change the comparison by mutating a snapshot.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(snapshot: PullRequestSnapshot): string {
  // Name the facts explicitly: incidental fetch metadata must not become a wake trigger.
  return canonical({
    state: snapshot.state,
    merged: snapshot.merged,
    draft: snapshot.draft,
    headSha: snapshot.headSha,
    mergeState: snapshot.mergeState,
    labels: snapshot.labels,
    mergeCommitSha: snapshot.mergeCommitSha,
    reviews: snapshot.reviews,
    reviewThreads: snapshot.reviewThreads,
    conversationComments: snapshot.conversationComments,
    ci: snapshot.ci,
    failingChecks: snapshot.failingChecks,
  });
}

/**
 * Yield current pull request facts, then changed snapshots until it closes.
 *
 * @remarks
 * The factory supplies a durable step to read GitHub. Duplicate wakes and collection ordering
 * changes do not yield again. Comments are included regardless of author or hidden metadata;
 * the consumer decides what needs attention and owns its action limits and merge policy.
 * The service poll and GitHub webhooks wake the same exclusive hook used by `pullRequestGate`.
 * Closing the iterator releases that hook. A closed snapshot is yielded before the iterator ends.
 */
export async function* watchPullRequest(
  pr: PullRequestRef,
  fetchState: FetchPrState,
): AsyncGenerator<PullRequestSnapshot, void, undefined> {
  const token = pullRequestToken(pr);
  const hook = createHook<unknown>({ token });
  try {
    const conflict = await hook.getConflict();
    if (conflict !== null) throw new ClaimConflictError(token, conflict.runId);
    let previous: string | undefined;
    while (true) {
      const snapshot = await fetchState(pr);
      const current = fingerprint(snapshot);
      const closed = snapshot.state === "closed";
      if (current !== previous) {
        previous = current;
        yield snapshot;
      }
      if (closed) return;
      await hook;
    }
  } finally {
    hook.dispose();
  }
}
