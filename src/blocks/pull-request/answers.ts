// Everything jigs writes onto a pull request: the builder's answers routed to
// the thread each one belongs to, the notes that record a commit or a
// stand-down, and the failing-check table those notes embed. Every body
// carries at least one marker.
//
// **Post-once.** jigs posts each answer at most once because every wake reads
// GitHub first: the classifier that produced the wake has already seen which
// comments carry an answer of this scope, and yields only what is still
// outstanding. There is no second check here — nothing is read before posting,
// and nothing is compared. That is also why the two POST steps the factory
// wraps are single-attempt (`maxRetries = 0` in the generated `jigs.ts`): jigs
// never retries a write it cannot tell apart from a success. A post whose
// response is lost ends the wake here, quietly; the next wake — a webhook, or
// the five-minute nudge at worst — reads the pull request again and either
// finds the marker, in which case the answer is delivered and nothing more is
// owed, or does not, in which case it posts. A reply lost to a transport
// failure is therefore delayed by at most one nudge interval, never dropped
// and never doubled.

import type { CheckRun, PrRef, ReviewThread } from "../../providers/github.ts";
import type {
  commentOnPullRequest,
  replyToPullRequestReviewThread,
} from "../../steps/pull-request/pr.ts";
import type { ThreadAnswers } from "../builder-agent/answer-review.ts";
import {
  assertUsableScope,
  carriesMarker,
  commentSource,
  type MarkerKind,
  markBody,
  type PrMarker,
  type StatusReason,
} from "./marker.ts";
import { currentRunId } from "./writer.ts";

export interface PostReviewAnswersOptions {
  replyToPullRequestReviewThread: typeof replyToPullRequestReviewThread;
  commentOnPullRequest: typeof commentOnPullRequest;
  pr: PrRef;
  /** The continuation identity these answers belong to. */
  scope: string;
  answers: ThreadAnswers;
  /** The commit the round pushed, when it pushed one; the explanation names it. */
  committedSha?: string;
  // The wake's own threads: anything the model names outside them is invented,
  // and replying into it 404s.
  threads: ReviewThread[];
}

export interface PostPullRequestNoteOptions {
  commentOnPullRequest: typeof commentOnPullRequest;
  pr: PrRef;
  scope: string;
  /** The commit the note is about: a red head, or a head it could not merge. */
  headSha: string;
  /**
   * What the note says about that commit, so one note never silences another.
   * `merge` and `ci` stand it down; `merge-retry` only records that jigs
   * already reported a refusal it is waiting out.
   */
  reason: StatusReason;
  body: string;
}

// What a thread's human comments are called in a marker. jigs' own replies are
// excluded by their markers, so an answer never claims to answer itself.
function threadSources(thread: ReviewThread): string[] {
  return thread.comments.filter((comment) => !carriesMarker(comment.body)).map(commentSource);
}

// The one failure this module handles rather than raises: the write may have
// landed, so retrying it now could double-post, and failing the run would
// throw away a delivery the next wake can finish. Ending the wake is the
// cheapest correct thing to do.
function postFailed(pr: PrRef, what: string, error: unknown): void {
  console.log(
    `[pullRequest] ${pr.owner}/${pr.repo}#${pr.number} could not post ${what}: ${String(error)} — ending this wake; the next one reposts it unless it landed`,
  );
}

/**
 * Posts each answer where it belongs, marked with the sources it answers. A
 * synthetic conversation thread has no inline anchor, so its answer lands on
 * the conversation. Posting stops at the first failure: what is still
 * unanswered comes back on the next wake.
 */
export async function postReviewAnswers(options: PostReviewAnswersOptions): Promise<void> {
  const { commentOnPullRequest: comment, replyToPullRequestReviewThread: reply, pr } = options;
  assertUsableScope(options.scope);
  const run = currentRunId();
  const known = new Map(options.threads.map((thread) => [thread.rootId, thread]));
  if (known.size < options.threads.length) {
    // An inline root and a review or conversation id are numbered separately
    // by GitHub and can collide. The rootId stays as it is — the model reads
    // it — so the shadowed thread is reported rather than renamed.
    console.log(
      `[postReviewAnswers] ${options.threads.length - known.size} thread(s) share a rootId with another in this wake`,
    );
  }
  const mark = (kind: MarkerKind, sources: Array<string | undefined>): PrMarker[] =>
    sources.map((source) => ({
      scope: options.scope,
      run,
      kind,
      ...(source === undefined ? {} : { source }),
    }));

  for (const answer of options.answers.answers) {
    const thread = answer.threadId === null ? undefined : known.get(answer.threadId);
    if (answer.threadId !== null && thread === undefined) {
      console.log(
        `[postReviewAnswers] answer named unknown thread ${answer.threadId} — posting on the conversation instead`,
      );
    }
    // An answer naming no thread lands on the conversation, so it answers the
    // conversation's own threads and nothing anchored to a line: an inline
    // comment is only answered by a reply in its thread, where the reviewer
    // reads it.
    const sources =
      thread === undefined
        ? options.threads.filter((each) => each.origin === "conversation").flatMap(threadSources)
        : threadSources(thread);
    if (sources.length === 0) {
      console.log(
        `[postReviewAnswers] ${pr.owner}/${pr.repo}#${pr.number} answer ${answer.threadId === null ? "named no thread" : `named thread ${answer.threadId}`} and so answers nothing — it will be posted, and whatever it meant to answer stays outstanding`,
      );
    }
    // Sourceless when it answers nothing nameable: the marker still has to be
    // there, or jigs reads its own words back as a reviewer's next time.
    const body = markBody(answer.body, mark("reply", sources.length === 0 ? [undefined] : sources));
    try {
      if (thread === undefined || thread.origin === "conversation") {
        await comment(pr, body);
      } else {
        await reply(pr, thread.rootId, body);
      }
    } catch (error) {
      postFailed(
        pr,
        thread === undefined ? "an answer" : `the answer to thread ${thread.rootId}`,
        error,
      );
      return;
    }
  }

  const sha = options.committedSha;
  if (sha === undefined) return;
  const explanation = options.answers.commitExplanation;
  if (explanation === null) {
    console.log(
      "[postReviewAnswers] revision committed changes without an explanation — posting answers only",
    );
    return;
  }
  try {
    await comment(pr, markBody(explanation, mark("completion", [sha])));
  } catch (error) {
    postFailed(pr, `the explanation of ${sha}`, error);
  }
}

/**
 * Posts a note about a commit — a merge jigs could not make, CI it could not
 * repair — marked with the commit it settles, so the next wake does not ask
 * for the same attempt again. A note that cannot be posted is logged and the
 * wake ends; the state it describes is still there to be reassessed.
 */
export async function postPullRequestNote(options: PostPullRequestNoteOptions): Promise<void> {
  const { pr, headSha } = options;
  assertUsableScope(options.scope);
  try {
    await options.commentOnPullRequest(
      pr,
      markBody(options.body, [
        {
          scope: options.scope,
          run: currentRunId(),
          kind: "status",
          reason: options.reason,
          source: headSha,
        },
      ]),
    );
  } catch (error) {
    postFailed(pr, `the ${options.reason} note for ${headSha}`, error);
  }
}

export function renderChecks(failing: CheckRun[]): string {
  return failing.length === 0
    ? "_(the provider reported a red build without naming a check)_"
    : failing
        .map((check) => {
          // A commit status may carry no target_url at all, and a line
          // trailing off into an empty link reads as a broken one.
          const named = `- **${check.name}** — ${check.conclusion}`;
          return check.url === "" ? named : `${named} — ${check.url}`;
        })
        .join("\n");
}
