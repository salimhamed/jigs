// Everything jigs writes onto a pull request: the builder's answers routed to
// the thread each one belongs to, and the failing-check table the stand-down
// comments embed.

import type { CheckRun, PrRef, ReviewThread } from "../../providers/github.ts";
import type {
  commentOnPr,
  replyInThread,
} from "../../steps/pull-request/pr.ts";
import type { ThreadAnswers } from "../builder-agent/answer-review.ts";

export interface PostReviewAnswersOptions {
  replyInThread: typeof replyInThread;
  commentOnPr: typeof commentOnPr;
  pr: PrRef;
  answers: ThreadAnswers;
  // The wake's own threads: anything the model names outside them is invented,
  // and replying into it 404s, which burns the step's three retries.
  threads: ReviewThread[];
}

/**
 * Posts each answer where it belongs and returns the ids of the thread replies
 * — the gate cursor needs jigs' own comment ids to tell its last word on a
 * thread from a human's. Conversation comments are left out: they never appear
 * among the review threads the guard filters.
 */
export async function postReviewAnswers(
  options: PostReviewAnswersOptions,
): Promise<number[]> {
  const { commentOnPr: comment, replyInThread: reply, pr } = options;
  const known = new Set(options.threads.map((thread) => thread.rootId));
  const posted: number[] = [];
  for (const answer of options.answers.answers) {
    if (answer.threadId !== null && !known.has(answer.threadId)) {
      console.log(
        `[postReviewAnswers] answer named unknown thread ${answer.threadId} — posting on the conversation instead`,
      );
    }
    if (answer.threadId === null || !known.has(answer.threadId)) {
      await comment(pr, answer.body);
    } else {
      posted.push((await reply(pr, answer.threadId, answer.body)).id);
    }
  }
  return posted;
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
