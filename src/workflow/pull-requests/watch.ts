import { createHook } from "workflow";
import { ClaimConflictError } from "../linear/claim.ts";
import { type FetchPrState, type PullRequestRef, pullRequestToken } from "./gate.ts";
import { type PullRequestSnapshot, pullRequestSnapshotKey } from "./snapshot.ts";

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
      // Capture before yielding so consumer mutations cannot change the previous facts.
      const current = pullRequestSnapshotKey(snapshot);
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
