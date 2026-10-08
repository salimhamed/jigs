import { sleep } from "workflow";
import { JigsError } from "../errors.ts";
import type { BranchState } from "../git/committed-work.ts";
import { blockedMergeNote, isPullRequestMergeReady } from "../pull-requests/merge-ready.ts";
import type { ApprovalCoverage } from "../pull-requests/policy.ts";
import type { PullRequestRef } from "../pull-requests/pull-request.ts";
import type { PullRequestSnapshot } from "../pull-requests/snapshot.ts";
import { watchPullRequest } from "../pull-requests/watch.ts";
import { defaultPullRequestScope } from "../pull-requests/writer.ts";
import { formats, maintenanceReport, withFormat } from "./answers.ts";
import {
  type Delivery,
  type DeliveryPrompts,
  type DeliverySteps,
  type UnpublishedWork,
  withoutLocalPath,
} from "./delivery.ts";

/**
 * The parts of a delivery `followPullRequestToOutcome` reads.
 *
 * @group Pull request delivery
 */
export type FollowDelivery<W> = Pick<Delivery<W>, "work" | "key" | "worktree" | "builder"> & {
  prompts: Pick<DeliveryPrompts<W>, "maintain">;
};

/**
 * Why a pull request needs a person, as facts for the workflow to word and send.
 *
 * @remarks
 * - `builder-asked`: the builder said it needs a person; `detail` is its summary.
 * - `attempts-exhausted`: the builder's attempts for one pull request update ran out with local
 *   work still unpublished; `detail` is its last summary.
 * - `merge-refused`: GitHub refused the merge; `detail` is the last refusal and `tries` how
 *   often jigs tried. A transient refusal is retried up to ten times before it is reported.
 * - `merge-blocked`: GitHub blocks an approved, green pull request from merging, usually because
 *   of a branch rule; `detail` says so in a sentence. Sent once per head. Mark a note posted
 *   about it with `headSha` and the delivery's scope, so it does not wake the builder and a later
 *   run does not post it again.
 *
 * `unpublished` is set when local work the pull request has never had holds back the merge.
 * The local worktree path never appears in `detail`.
 *
 * @group Pull request delivery
 */
export type NeedsHuman =
  | {
      reason: "builder-asked" | "attempts-exhausted";
      detail: string;
      unpublished?: UnpublishedWork | undefined;
    }
  | { reason: "merge-refused"; detail: string; tries: number }
  | { reason: "merge-blocked"; detail: string; headSha: string };

/**
 * What `followPullRequestToOutcome` needs besides the delivery and the pull request.
 *
 * @group Pull request delivery
 */
export interface FollowOptions {
  /** Builder turns allowed for each change to the pull request, including recovery. */
  attemptsPerUpdate: number;
  /**
   * The facts in a snapshot that wake the builder, one string each; it is woken for one it has
   * not been shown. `scope` is the delivery's marker scope. Pass `builderWakeFacts` for the
   * default rules, or your own function, for example to ignore another bot's comments.
   */
  wake: (snapshot: PullRequestSnapshot, scope: string) => string[];
  /**
   * Whether you consent to merging this snapshot now. jigs still merges only when GitHub reports
   * the pull request approved, green and clean, so this can only make merging stricter. Return
   * `false` to leave every merge to a person, or check the snapshot, such as for a label.
   */
  mergeWhen: (snapshot: PullRequestSnapshot) => boolean;
  /** Which commits a person's approving review covers. */
  approvalCovers: ApprovalCoverage;
  /**
   * Tell a person the pull request needs them. Watching goes on: the next change to the pull
   * request picks the work back up. The same facts are never sent twice in a row.
   */
  onNeedsHuman: (facts: NeedsHuman) => Promise<void>;
}

/**
 * How `followPullRequestToOutcome` ended: the pull request merged, or closed unmerged.
 *
 * @group Pull request delivery
 */
export type FollowResult = { outcome: "merged" } | { outcome: "closed" };

const MERGE_TRIES = 10;

/** One pull request's maintenance: its inputs, and what it remembers between watcher yields. */
interface Following<W> {
  delivery: FollowDelivery<W>;
  pr: PullRequestRef;
  options: FollowOptions;
  steps: DeliverySteps;
  scope: string;
  /** Wake facts the builder has already been shown. */
  seen: Set<string>;
  /** Every head the pull request has had, as read from GitHub. */
  prHeads: Set<string>;
  /** Heads already reported as merge-blocked. */
  blockedHeads: Set<string>;
  lastNeed?: string;
  /** Unpublished local state recovery gave up on; only a change to it wakes the builder again. */
  heldLocal?: string | undefined;
}

/**
 * Follow a pull request until it merges or closes, waking the builder for what it has to act on.
 *
 * @remarks
 * The builder session is woken for a fact from `wake` it has not been shown, and told which ones
 * are new. Local work the pull request has never had is recovered at
 * once, and holds back a merge until it is published: the worktree is clean and its HEAD is a
 * commit the pull request has had. After a builder turn whose push GitHub does not show yet, the
 * pull request is read again twice, 2 seconds apart, without spending an attempt.
 *
 * When `mergeWhen` agrees, an approved, green, clean pull request is merged after every read and
 * builder turn, whatever the builder reported; a transient refusal is retried up to ten times,
 * 30 seconds apart. Returns outcome `merged`, or `closed` when it closes unmerged. Nothing
 * is pushed on the way out.
 *
 * While it waits, a read of the pull request that fails is tried again on the next wake, so a
 * GitHub outage does not end the run; 12 failed reads in a row do.
 *
 * @group Pull request delivery
 */
export async function followPullRequestToOutcome<W>(
  delivery: FollowDelivery<W>,
  pr: PullRequestRef,
  options: FollowOptions,
  steps: DeliverySteps,
): Promise<FollowResult> {
  const following: Following<W> = {
    delivery,
    pr,
    options,
    steps,
    scope: defaultPullRequestScope(delivery.key),
    seen: new Set(),
    prHeads: new Set(),
    blockedHeads: new Set(),
  };
  const { approvalCovers } = options;
  for await (const snapshot of watchPullRequest(pr, steps.fetchPullRequestState, {
    approvalCovers,
  })) {
    following.prHeads.add(snapshot.headSha);
    let current = snapshot;
    if (current.state === "open") {
      const local = await steps.readBranchState(delivery.worktree);
      const work = unpublished(following, local, current);
      const recover = work !== undefined && following.heldLocal !== heldKey(work);
      if (recover || hasUnseenFacts(following, current)) {
        current = await maintain(following, current, work);
        // A newly pushed head is merged only from its own watcher yield.
        if (current.state === "open" && current.headSha !== snapshot.headSha) continue;
      }
    }
    if (current.state === "closed") return { outcome: current.merged ? "merged" : "closed" };
    // Checked after every yield and every builder turn: a turn that changes
    // nothing on GitHub produces no new yield to merge on.
    if (await mergeIfReady(following, current)) return { outcome: "merged" };
  }

  throw new JigsError(
    `the pull request watch for ${pr.owner}/${pr.repo}#${pr.number} ended without a close`,
  );
}

async function read<W>(following: Following<W>): Promise<PullRequestSnapshot> {
  const { pr, steps, options } = following;
  const snapshot = await steps.fetchPullRequestState(pr, {
    approvalCovers: options.approvalCovers,
  });
  following.prHeads.add(snapshot.headSha);
  return snapshot;
}

const unseenFacts = <W>(following: Following<W>, snapshot: PullRequestSnapshot) =>
  following.options.wake(snapshot, following.scope).filter((fact) => !following.seen.has(fact));

const hasUnseenFacts = <W>(following: Following<W>, snapshot: PullRequestSnapshot) =>
  unseenFacts(following, snapshot).length > 0;

// Local work behind the PR is fine (a person pushed); work the PR never had is not.
function unpublished<W>(
  following: Following<W>,
  local: BranchState,
  current: PullRequestSnapshot,
): UnpublishedWork | undefined {
  if (!local.dirty && following.prHeads.has(local.headSha)) return undefined;
  return { dirty: local.dirty, localHead: local.headSha, pullRequestHead: current.headSha };
}

const heldKey = (work: UnpublishedWork) => `${work.dirty}:${work.localHead}`;

async function needsHuman<W>(following: Following<W>, facts: NeedsHuman) {
  const posted = { ...facts, detail: withoutLocalPath(following.delivery.worktree, facts.detail) };
  const key = JSON.stringify(posted);
  if (key === following.lastNeed) return;
  following.lastNeed = key;
  await following.options.onNeedsHuman(posted);
}

// Builder turns for one update, until local work is published or the attempts
// run out.
async function maintain<W>(
  following: Following<W>,
  snapshot: PullRequestSnapshot,
  before: UnpublishedWork | undefined,
): Promise<PullRequestSnapshot> {
  const { delivery, pr, steps } = following;
  const { work, worktree, prompts } = delivery;
  let assessed = snapshot;
  let current = snapshot;
  let recovery = before;
  let summary = "";
  for (let attempt = 1; attempt <= following.options.attemptsPerUpdate; attempt++) {
    const news = unseenFacts(following, assessed);
    const facts = { pr, snapshot: assessed, news, recovery };
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
    for (const fact of news) following.seen.add(fact);
    let local = await steps.readBranchState(worktree);
    current = await read(following);
    if (current.state === "closed") return current;
    if (report.needsHuman) {
      const held = unpublished(following, local, current);
      following.heldLocal = held && heldKey(held);
      await needsHuman(following, {
        reason: "builder-asked",
        detail: report.summary,
        unpublished: held,
      });
      return current;
    }

    // A successful push may reach GitHub's PR reader shortly afterward.
    // These two durable waits do not consume another builder attempt.
    for (
      let recheck = 0;
      !local.dirty && unpublished(following, local, current) !== undefined && recheck < 2;
      recheck++
    ) {
      await sleep("2s");
      current = await read(following);
      local = await steps.readBranchState(worktree);
      if (current.state === "closed") return current;
    }

    const held = unpublished(following, local, current);
    following.heldLocal = held && heldKey(held);
    if (held === undefined) return current;
    recovery = held;
    // Recovery is local work, not an external event: retry without waiting
    // for a new watcher yield, even if GitHub has not changed at all.
    assessed = current;
  }
  await needsHuman(following, {
    reason: "attempts-exhausted",
    detail: summary,
    unpublished: recovery,
  });
  return current;
}

// Readiness is GitHub's to decide, not the builder's: an approved, green,
// clean head merges whatever the builder last reported. The caller's consent
// is asked on every attempt, so it can only hold a merge back.
async function mergeIfReady<W>(following: Following<W>, snapshot: PullRequestSnapshot) {
  const { delivery, pr, steps, options } = following;
  let current = snapshot;
  let reason = "";
  for (let attempt = 1; attempt <= MERGE_TRIES; attempt++) {
    if (attempt > 1) {
      await sleep("30s");
      current = await read(following);
    }
    if (current.state !== "open" || hasUnseenFacts(following, current)) return false;
    const consented = options.mergeWhen(current);
    if (!consented || !isPullRequestMergeReady(current)) {
      const blocked = consented ? blockedMergeNote(current) : null;
      if (blocked !== null && !following.blockedHeads.has(current.headSha)) {
        following.blockedHeads.add(current.headSha);
        await needsHuman(following, {
          reason: "merge-blocked",
          detail: blocked,
          headSha: current.headSha,
        });
      }
      // After a refusal, keep polling: GitHub settling back to the yielded
      // state matches the watcher's last key, so the watcher would never yield it.
      if (attempt > 1) continue;
      return false;
    }
    const local = await steps.readBranchState(delivery.worktree);
    if (unpublished(following, local, current) !== undefined) return false;
    const result = await steps
      .mergePullRequest(pr, current.headSha, {
        approvalCovers: options.approvalCovers,
      })
      .catch((error: unknown) => ({
        merged: false as const,
        reason: String(error),
        transient: true,
      }));
    if (result.merged) return true;
    if (!result.transient) {
      await needsHuman(following, {
        reason: "merge-refused",
        detail: result.reason,
        tries: attempt,
      });
      return false;
    }
    reason = result.reason;
  }
  await needsHuman(following, { reason: "merge-refused", detail: reason, tries: MERGE_TRIES });
  return false;
}
