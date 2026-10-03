import { sleep } from "workflow";
import { JigsError } from "../errors.ts";
import { blockedMergeNote, isPullRequestMergeReady } from "../pull-requests/merge-ready.ts";
import type { ApprovalCoverage } from "../pull-requests/policy.ts";
import type { PullRequestRef } from "../pull-requests/pull-request.ts";
import type { PullRequestSnapshot } from "../pull-requests/snapshot.ts";
import { watchPullRequest } from "../pull-requests/watch.ts";
import { defaultPullRequestScope } from "../pull-requests/writer.ts";
import { formats, maintenanceReport, withFormat } from "./answers.ts";
import {
  claimKey,
  type Delivery,
  type DeliverySteps,
  type UnpublishedWork,
  withoutLocalPath,
} from "./delivery.ts";
import { builderWakeFacts } from "./wake.ts";

/**
 * Why a pull request needs a person, as facts for the workflow to word and send.
 *
 * @remarks
 * - `builder-asked`: the builder returned needs-human; `detail` is its summary.
 * - `attempts-exhausted`: the builder's attempts for one pull request update ran out with local
 *   work still unpublished; `detail` is its last summary.
 * - `merge-refused`: GitHub refused the merge, or a transient refusal outlasted the retries;
 *   `detail` is the refusal.
 *
 * `unpublished` is set when local work the pull request has never had holds back the merge.
 * The local worktree path never appears in `detail`.
 *
 * @group Pull request delivery
 */
export interface NeedsHuman {
  reason: "builder-asked" | "attempts-exhausted" | "merge-refused";
  detail: string;
  pr: PullRequestRef;
  unpublished?: UnpublishedWork | undefined;
}

/**
 * An approved, green pull request that GitHub still blocks from merging, usually because of a
 * branch rule. `detail` says so in a sentence. A note posted about it should carry `scope` and
 * `headSha` in its marker, so the builder is not woken by it and it is posted once per head.
 *
 * @group Pull request delivery
 */
export interface MergeBlocked {
  pr: PullRequestRef;
  headSha: string;
  scope: string;
  detail: string;
}

/**
 * What `followPullRequestToOutcome` needs besides the delivery and the pull request.
 *
 * @group Pull request delivery
 */
export interface FollowOptions {
  /** Builder turns allowed for each change to the pull request, including recovery. */
  attemptsPerUpdate: number;
  /** Who merges once the pull request is approved, green and clean. */
  mergedBy: "jigs" | "human";
  /** Which commits a person's approving review covers. */
  approvalCovers: ApprovalCoverage;
  /**
   * Tell a person the pull request needs them. Watching goes on: the next change to the pull
   * request picks the work back up. The same facts are never sent twice in a row.
   */
  onNeedsHuman: (facts: NeedsHuman) => Promise<void>;
  /** Called on every read of an approved, green pull request GitHub blocks. */
  onMergeBlocked?: ((facts: MergeBlocked) => Promise<void>) | undefined;
}

const MERGE_TRIES = 10;

type LocalState = { dirty: boolean; headSha: string };

/** What one pull request's maintenance remembers between watcher yields. */
interface Following<W> extends FollowOptions {
  delivery: Delivery<W>;
  steps: DeliverySteps;
  pr: PullRequestRef;
  scope: string;
  /** Wake facts the builder has already been shown. */
  seen: Set<string>;
  /** Every head the pull request has had, as read from GitHub. */
  prHeads: Set<string>;
  lastNeed?: string;
  /** Unpublished local state recovery gave up on; only a change to it wakes the builder again. */
  heldLocal?: string | undefined;
}

/**
 * Follow a pull request until it merges or closes, waking the builder for what it has to act on.
 *
 * @remarks
 * The builder session is woken for new reviews with a body or requesting changes, new comments,
 * a newly failing check and a conflict with the base. Checks that queue, run or pass, a bare
 * approval, the App bot's unmarked comments (the builder's own replies) and notes marked with
 * this delivery's scope wake nothing. Local work the pull request has never had is recovered at
 * once, and holds back a merge until it is published.
 *
 * With `mergedBy: "jigs"`, an approved, green, clean pull request is merged after every read
 * and builder turn, whatever the builder reported; a transient refusal is retried up to ten
 * times, 30 seconds apart. Returns `"merged"`, or `"closed"` when it closes unmerged. Nothing
 * is pushed on the way out.
 *
 * @group Pull request delivery
 */
export async function followPullRequestToOutcome<W>(
  delivery: Delivery<W>,
  pr: PullRequestRef,
  options: FollowOptions,
  steps: DeliverySteps,
): Promise<"merged" | "closed"> {
  claimKey(delivery);
  const following: Following<W> = {
    ...options,
    delivery,
    steps,
    pr,
    scope: defaultPullRequestScope(delivery.key),
    seen: new Set(),
    prHeads: new Set(),
  };
  const read = { approvalCovers: options.approvalCovers };
  for await (const snapshot of watchPullRequest(pr, steps.fetchPullRequestState, read)) {
    let current = observe(following, snapshot);
    if (current.state === "open") {
      const local = await steps.readBranchState(delivery.worktree);
      const recover = !isPublished(following, local) && following.heldLocal !== localKey(local);
      if (recover || hasUnseenFacts(following, current)) {
        current = await maintain(following, current, local);
        // A newly pushed head is merged only from its own watcher yield.
        if (current.state === "open" && current.headSha !== snapshot.headSha) continue;
      }
    }
    if (current.state === "closed") return current.merged ? "merged" : "closed";
    // Checked after every yield and every builder turn: a turn that changes
    // nothing on GitHub produces no new yield to merge on.
    if (await mergeIfReady(following, current)) return "merged";
  }

  throw new JigsError(
    `the pull request watch for ${pr.owner}/${pr.repo}#${pr.number} ended without a close`,
  );
}

function observe<W>(following: Following<W>, snapshot: PullRequestSnapshot) {
  following.prHeads.add(snapshot.headSha);
  return snapshot;
}

const hasUnseenFacts = <W>(following: Following<W>, snapshot: PullRequestSnapshot) =>
  builderWakeFacts(snapshot, following.scope).some((fact) => !following.seen.has(fact));

// Local work behind the PR is fine (a person pushed); work the PR never had is not.
const isPublished = <W>(following: Following<W>, local: LocalState) =>
  !local.dirty && following.prHeads.has(local.headSha);

const localKey = (local: LocalState) => `${local.dirty}:${local.headSha}`;

const unpublished = (local: LocalState, current: PullRequestSnapshot): UnpublishedWork => ({
  dirty: local.dirty,
  localHead: local.headSha,
  pullRequestHead: current.headSha,
});

// Remembers local work that holds back the merge, and returns it.
function holdUnpublished<W>(
  following: Following<W>,
  local: LocalState,
  current: PullRequestSnapshot,
): UnpublishedWork | undefined {
  const held = !isPublished(following, local);
  following.heldLocal = held ? localKey(local) : undefined;
  return held ? unpublished(local, current) : undefined;
}

async function needsHuman<W>(
  following: Following<W>,
  reason: "builder-asked" | "attempts-exhausted" | "merge-refused",
  detail: string,
  held?: UnpublishedWork,
) {
  const facts: NeedsHuman = {
    reason,
    detail: withoutLocalPath(following.delivery.worktree, detail),
    pr: following.pr,
    ...(held === undefined ? {} : { unpublished: held }),
  };
  const key = JSON.stringify([facts.reason, facts.detail, facts.unpublished]);
  if (key === following.lastNeed) return;
  following.lastNeed = key;
  await following.onNeedsHuman(facts);
}

async function readAfterTurn<W>(following: Following<W>): Promise<PullRequestSnapshot> {
  const { pr, steps, approvalCovers } = following;
  return observe(following, await steps.fetchPullRequestState(pr, { approvalCovers }));
}

// Builder turns for one update, until local work is published or the attempts
// run out.
async function maintain<W>(
  following: Following<W>,
  snapshot: PullRequestSnapshot,
  before: LocalState,
): Promise<PullRequestSnapshot> {
  const { delivery, pr, steps, attemptsPerUpdate } = following;
  const { work, worktree, prompts } = delivery;
  let assessed = snapshot;
  let current = snapshot;
  let recovery = isPublished(following, before) ? undefined : unpublished(before, snapshot);
  let summary = "";
  for (let attempt = 1; attempt <= attemptsPerUpdate; attempt++) {
    const facts = { pr, snapshot: assessed, recovery };
    const report = await delivery.builder.run({
      output: maintenanceReport,
      resume: withFormat(prompts.maintain.resume(facts), formats.maintain),
      fresh: async () =>
        withFormat(
          prompts.maintain.fresh({
            ...facts,
            work,
            worktree,
            diff: await steps.readWorktreeDiff(worktree),
          }),
          formats.maintain,
        ),
    });
    summary = report.summary;
    // Remember only what the builder saw, never a newer post-turn read.
    for (const fact of builderWakeFacts(assessed, following.scope)) following.seen.add(fact);
    let local = await steps.readBranchState(worktree);
    current = await readAfterTurn(following);
    if (current.state === "closed") return current;
    if (report.status === "needs-human") {
      const held = holdUnpublished(following, local, current);
      await needsHuman(following, "builder-asked", report.summary, held);
      return current;
    }

    // A successful push may reach GitHub's PR reader shortly afterward.
    // These two durable waits do not consume another builder attempt.
    for (
      let recheck = 0;
      !local.dirty && !isPublished(following, local) && recheck < 2;
      recheck++
    ) {
      await sleep("2s");
      current = await readAfterTurn(following);
      local = await steps.readBranchState(worktree);
      if (current.state === "closed") return current;
    }

    const held = holdUnpublished(following, local, current);
    if (held === undefined) return current;
    recovery = held;
    // Recovery is local work, not an external event: retry without waiting
    // for a new watcher yield, even if GitHub has not changed at all.
    assessed = current;
  }
  await needsHuman(following, "attempts-exhausted", summary, recovery);
  return current;
}

// Readiness is GitHub's to decide, not the builder's: an approved, green,
// clean head merges whatever the builder last reported.
async function mergeIfReady<W>(following: Following<W>, snapshot: PullRequestSnapshot) {
  const { delivery, pr, steps, approvalCovers } = following;
  if (following.mergedBy !== "jigs") return false;
  let current = snapshot;
  let reason = "";
  for (let attempt = 1; attempt <= MERGE_TRIES; attempt++) {
    if (attempt > 1) {
      await sleep("30s");
      current = await readAfterTurn(following);
    }
    if (current.state !== "open" || hasUnseenFacts(following, current)) return false;
    if (!isPullRequestMergeReady(current)) {
      await reportBlocked(following, current);
      // After a refusal, keep polling: GitHub settling back to the yielded
      // state matches the watcher's last key, so the watcher would never yield it.
      if (attempt > 1) continue;
      return false;
    }
    if (!isPublished(following, await steps.readBranchState(delivery.worktree))) return false;
    const result = await steps
      .mergePullRequest(delivery.worktree, pr, current.headSha, { approvalCovers })
      .catch((error: unknown) => ({
        merged: false as const,
        reason: String(error),
        transient: true,
      }));
    if (result.merged) return true;
    if (!result.transient) {
      await needsHuman(following, "merge-refused", result.reason);
      return false;
    }
    reason = result.reason;
  }
  await needsHuman(following, "merge-refused", reason);
  return false;
}

async function reportBlocked<W>(following: Following<W>, snapshot: PullRequestSnapshot) {
  const detail = blockedMergeNote(snapshot);
  if (detail === null || following.onMergeBlocked === undefined) return;
  await following.onMergeBlocked({
    pr: following.pr,
    headSha: snapshot.headSha,
    scope: following.scope,
    detail,
  });
}
