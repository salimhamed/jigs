// Everything jigs writes onto a pull request: the builder's answers routed to
// the thread each one belongs to, and the failing-check table the stand-down
// comments embed.

import type { CheckRun, PrRef, ReviewThread } from "../../providers/github.ts";
import type {
  commentOnPullRequest,
  replyToPullRequestReviewThread,
} from "../../steps/pull-request/pr.ts";
import type { ThreadAnswers } from "../builder-agent/answer-review.ts";
import type { GateAck } from "./gate.ts";

export interface PostReviewAnswersOptions {
  replyToPullRequestReviewThread: typeof replyToPullRequestReviewThread;
  commentOnPullRequest: typeof commentOnPullRequest;
  pr: PrRef;
  answers: ThreadAnswers;
  postCommitExplanation: boolean;
  // The wake's own threads: anything the model names outside them is invented,
  // and replying into it 404s, which burns the step's three retries.
  threads: ReviewThread[];
}

/**
 * Posts each answer where it belongs and returns the ack the gate cursor needs
 * — jigs' own comment ids, the only way to tell its last word from a human's
 * on a factory that shares its operator's GitHub identity. A synthetic
 * conversation thread has no inline anchor, so its answer lands on the
 * conversation and is acked in the conversation's own id space.
 */
export async function postReviewAnswers(options: PostReviewAnswersOptions): Promise<GateAck> {
  const { commentOnPullRequest: comment, replyToPullRequestReviewThread: reply, pr } = options;
  const known = new Map(options.threads.map((thread) => [thread.rootId, thread]));
  if (known.size < options.threads.length) {
    // An inline root and a review or conversation id are numbered separately
    // by GitHub and can collide. The rootId stays as it is — the model reads
    // it — so the shadowed thread is reported rather than renamed.
    console.log(
      `[postReviewAnswers] ${options.threads.length - known.size} thread(s) share a rootId with another in this wake`,
    );
  }
  const ack: Required<GateAck> = { selfCommentIds: [], selfConversationCommentIds: [] };
  const explanation = options.answers.commitExplanation;
  if (options.postCommitExplanation && explanation === null) {
    throw new Error("Pull request revision committed changes without an explanation");
  }
  const commitExplanation = options.postCommitExplanation ? explanation : null;
  for (const answer of options.answers.answers) {
    const thread = answer.threadId === null ? undefined : known.get(answer.threadId);
    if (answer.threadId !== null && thread === undefined) {
      console.log(
        `[postReviewAnswers] answer named unknown thread ${answer.threadId} — posting on the conversation instead`,
      );
    }
    if (thread === undefined || thread.origin === "conversation") {
      ack.selfConversationCommentIds.push((await comment(pr, answer.body)).id);
    } else {
      ack.selfCommentIds.push((await reply(pr, thread.rootId, answer.body)).id);
    }
  }
  if (commitExplanation !== null) {
    ack.selfConversationCommentIds.push((await comment(pr, commitExplanation)).id);
  }
  return ack;
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
