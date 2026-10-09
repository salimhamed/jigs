import { createHook } from "workflow";
import { ClaimConflictError } from "../linear/claim.ts";
import {
  type FetchPrState,
  type PullRequestReadOptions,
  type PullRequestRef,
  pullRequestToken,
} from "./pull-request.ts";
import { type PullRequestSnapshot, pullRequestSnapshotKey } from "./snapshot.ts";

// About an hour of failed reads at the service's default five-minute poll.
const FAILED_READS_IN_A_ROW = 12;

/**
 * Yield current pull request facts, then changed snapshots until it closes.
 *
 * @remarks
 * The factory supplies a durable step to read GitHub. Duplicate wakes and collection ordering
 * changes do not yield again. Comments are included regardless of author or hidden metadata;
 * the consumer decides what needs attention, owns its action limits and decides who merges.
 * GitHub events from the hub and `jigs poke` wake an exclusive hook, so only one run can watch a given
 * pull request at a time. Closing the iterator releases that hook. A closed snapshot is yielded before the iterator ends.
 * `options` say how each read counts approvals. A failed read is tried again on the next wake; the
 * watch fails only after 12 failed reads in a row.
 */
export async function* watchPullRequest(
  pr: PullRequestRef,
  fetchState: FetchPrState,
  options?: PullRequestReadOptions,
): AsyncGenerator<PullRequestSnapshot, void, undefined> {
  const token = pullRequestToken(pr);
  const hook = createHook<unknown>({ token });
  try {
    const conflict = await hook.getConflict();
    if (conflict !== null) throw new ClaimConflictError(token, conflict.runId);
    let previous: string | undefined;
    let failedReads = 0;
    while (true) {
      let snapshot: PullRequestSnapshot;
      try {
        snapshot = await fetchState(pr, options);
        failedReads = 0;
      } catch (error) {
        failedReads += 1;
        if (failedReads >= FAILED_READS_IN_A_ROW) throw error;
        await hook;
        continue;
      }
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
