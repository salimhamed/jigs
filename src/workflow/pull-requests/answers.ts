import type {
  CheckRun,
  PullRequestRef,
  PullRequestSnapshot,
  ReviewThread,
} from "../../providers/github.ts";
import type {
  commentOnPullRequest,
  replyToPullRequestReviewThread,
} from "../../steps/pull-requests/pr.ts";
import {
  assertUsableScope,
  carriesMarker,
  commentSource,
  type MarkerKind,
  type MarkerLedger,
  markBody,
  type PullRequestMarker,
  readLedger,
  type StatusReason,
} from "./marker.ts";
import type { FetchPrState } from "./pull-request.ts";
import { currentRunId } from "./writer.ts";

/**
 * Answers routed back to pull-request threads and an optional commit explanation.
 *
 * @group Pull requests
 */
export interface ThreadAnswers {
  /** Replies to post, using `null` to answer feedback on the pull request conversation. */
  answers: Array<{
    /** The review thread root to answer, or `null` for conversation feedback. */
    threadId: number | null;
    /** The Markdown reply body. */
    body: string;
  }>;
  /** A note explaining the pushed commit, or `null` when no explanation should be posted. */
  commitExplanation: string | null;
}

/** Inputs for posting one revision round's answers. */
export interface PostReviewAnswersOptions {
  /** Factory-owned step used to reply to an inline review thread. */
  replyToPullRequestReviewThread: typeof replyToPullRequestReviewThread;
  /** Factory-owned step used to post on the pull request conversation. */
  commentOnPullRequest: typeof commentOnPullRequest;
  /** The pull request receiving the answers. */
  pr: PullRequestRef;
  /** The continuation identity these answers belong to. */
  scope: string;
  /** Replies and optional commit explanation produced for this revision round. */
  answers: ThreadAnswers;
  /** The commit the round pushed, when it pushed one; the explanation names it. */
  committedSha?: string | undefined;
  /** The wake's known threads, used to reject invented anchors and route each answer. */
  threads: ReviewThread[];
}

/** Inputs for posting one commit-scoped pull request status note. */
export interface PostPullRequestNoteOptions {
  /** Factory-owned step used to read what the pull request already records. */
  fetchPullRequestState: FetchPrState;
  /** Factory-owned step used to post on the pull request conversation. */
  commentOnPullRequest: typeof commentOnPullRequest;
  /** The pull request receiving the note. */
  pr: PullRequestRef;
  /** The continuation identity that owns the note. */
  scope: string;
  /** The commit the note is about: a red head, or a head it could not merge. */
  headSha: string;
  /** Labels the update so CI and merge notes for the same commit stay independent. */
  reason: StatusReason;
  /** The Markdown note body. */
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
function postFailed(pr: PullRequestRef, what: string, error: unknown): void {
  console.log(
    `[pullRequest] ${pr.owner}/${pr.repo}#${pr.number} could not post ${what}: ${String(error)} — ending this wake; the next one reposts it unless it landed`,
  );
}

/**
 * Post replies to review threads or the pull request conversation, marked with the feedback answered.
 *
 * @remarks
 * Each call posts the supplied answers; the workflow decides which feedback still needs a reply.
 * Posting stops and logs the error on the first failure. The caller decides whether and when
 * to retry after reading fresh facts. An optional commit explanation is posted after the replies.
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
  const mark = (kind: MarkerKind, sources: Array<string | undefined>): PullRequestMarker[] =>
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

// Every comment body on the pull request, wherever it hangs: the markers in
// them are the whole record of what jigs has done here.
function readPullRequestLedger(snapshot: PullRequestSnapshot, scope: string): MarkerLedger {
  return readLedger(
    [
      ...snapshot.reviews.map((review) => review.body),
      ...snapshot.reviewThreads.flatMap((thread) => thread.comments.map((comment) => comment.body)),
      ...snapshot.conversationComments.map((comment) => comment.body),
    ],
    scope,
  );
}

/**
 * Post a status note once per scope, commit and reason.
 *
 * @remarks
 * Reads current pull request comments and skips a note whose marker is already present.
 * A posting failure is logged and returns without throwing. The workflow decides whether
 * and when to try again; the note does not change merge readiness or schedule another action.
 */
export async function postPullRequestNote(options: PostPullRequestNoteOptions): Promise<void> {
  const { pr, headSha, reason } = options;
  assertUsableScope(options.scope);
  const ledger = readPullRequestLedger(await options.fetchPullRequestState(pr), options.scope);
  if (ledger.settled[reason].has(headSha)) return;
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

/**
 * Render failed checks as a Markdown list for a pull request note.
 *
 * @group Pull requests
 */
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
