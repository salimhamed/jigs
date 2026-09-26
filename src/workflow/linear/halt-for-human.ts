// The halt routine: post the question to the ticket, then suspend until a human
// answers. Every provider call, env read and time read lives in the two step
// implementations this routine is handed — ../../steps/linear/needs-human-comments.ts —
// so the body here only sequences memoized step results. Cursors and ids come
// from step returns, never from Date.now() or process.env.

import { createHook } from "workflow";
import { decide } from "../agents/decide.ts";
import type { ExecuteJevStep } from "../agents/jev.ts";
import type { HaltQuestion } from "../human/questions.ts";
import type { TicketClaim } from "./claim.ts";
import { ticketReply, ticketReplyState } from "./decisions.ts";

// The halt's marker hook. It names no external resource and nothing resumes
// it: the reply that ends the halt lands on the ticket claim.
/** Prefix for marker hooks that tell operators which ticket comment needs an answer. */
export const NEEDS_HUMAN_TOKEN_PREFIX = "jigs:needs-human:";

/** Build the marker token for a run's unanswered ticket comment. */
export function needsHumanToken(issueId: string, commentId: string): string {
  return `${NEEDS_HUMAN_TOKEN_PREFIX}${issueId}:${commentId}`;
}

/**
 * What the ticket comment says, in the words a stranger to the repo reads.
 * `headline` is one plain sentence naming what jigs paused and why, `where`
 * names the routine it paused in so the footer can say so, `about` restates the
 * ticket itself, `notes` are plain bullet lines, and `onReply` decides what
 * the comment asks the human to do: choose between the questions ("continue")
 * or repair something and let the step run again ("retry"). `mention` adds
 * people, by Linear email, to the operator (or the creator) and the assignee
 * the comment already mentions; an email no Linear user has is skipped.
 *
 * @group Human input
 */
export type Halt = {
  headline: string;
  where: string;
  about?: string | undefined;
  questions?: HaltQuestion[] | undefined;
  notes?: string[] | undefined;
  onReply: "continue" | "retry";
  mention?: string[] | undefined;
};

/**
 * The first human ticket reply that wakes a halted run.
 *
 * @group Human input
 */
export interface HumanReply {
  commentId: string;
  body: string;
  author: { id: string; name: string };
  createdAt: string;
}

// Declared here rather than written as `typeof postTicketHumanInputRequest`:
// declaring the contract in workflow/ typechecks the step against the routine and
// keeps this side free of any value import into steps/.
/** Durable step contract for posting a question and recording its cursor. */
export type PostTicketHumanInputRequest = (
  issueId: string,
  halt: Halt,
) => Promise<{ commentId: string; postedAt: string }>;

/** Durable step contract for finding a human reply after a cursor, skipping the run's own comments. */
export type CheckForTicketHumanReply = (
  issueId: string,
  sinceIso: string,
  postedCommentIds: readonly string[],
) => Promise<{ reply: HumanReply | null; cursor: string }>;

/** Durable operations required to post and resume a human halt. */
export type HaltForHumanDependencies = {
  postTicketHumanInputRequest: PostTicketHumanInputRequest;
  checkForTicketHumanReply: CheckForTicketHumanReply;
  executeJev: ExecuteJevStep;
};

/** {@link haltForHuman} with its steps already bound, as a workflow calls it. */
export type HaltForHumanFn = (claim: TicketClaim, halt: Halt) => Promise<HumanReply>;

// Posts the halt to the Linear ticket (@-mentioning the operator, or the
// creator, and the assignee), then suspends on the claim hook. A wake is the
// service's poll or, with Linear webhooks on, a comment delivery, and either
// carries nothing: each one re-reads the comment thread from Linear and
// re-suspends when no human has replied — no agent step executes on an
// unsatisfied wake. A comment Jev is sure does not answer the question is passed
// over, and the wait goes on.
/** Post a ticket question and suspend until a human replies to the claim hook. */
export async function haltForHuman(
  claim: TicketClaim,
  halt: Halt,
  deps: HaltForHumanDependencies,
): Promise<HumanReply> {
  // Destructured, never invoked as `deps.postTicketHumanInputRequest(...)`: the SDK
  // serializes a step call's receiver along with its arguments, and this
  // object holds functions.
  const { checkForTicketHumanReply, postTicketHumanInputRequest, executeJev } = deps;
  const posted = await postTicketHumanInputRequest(claim.issueId, halt);
  claim.postedCommentIds.push(posted.commentId);
  // The halt's only signal: the claim hook is held for the run's whole life,
  // so this marker is what tells `jigs status` the run is parked on a human. Never
  // awaited — it registers when the run suspends on the claim hook below.
  const marker = createHook<never>({
    token: needsHumanToken(claim.issueId, posted.commentId),
  });
  try {
    let cursor = posted.postedAt;
    // Passed-over comments are excluded by id, not by moving the cursor: a real
    // answer may share the read that surfaced them.
    const passedOver: string[] = [];
    for await (const _hint of claim.hook) {
      for (;;) {
        const check = await checkForTicketHumanReply(claim.issueId, cursor, [
          ...claim.postedCommentIds,
          ...passedOver,
        ]);
        if (check.reply === null) {
          cursor = check.cursor;
          break;
        }
        const { answers } = await decide(
          {
            site: "ticket-reply",
            state: ticketReplyState(halt, check.reply.body),
            questions: { answers: { question: ticketReply, whenUnsure: true } },
          },
          executeJev,
        );
        if (answers) return check.reply;
        console.log(
          `[haltForHuman] ${claim.identifier} passed over comment=${check.reply.commentId}: not an answer`,
        );
        passedOver.push(check.reply.commentId);
      }
    }
    throw new Error("claim hook stopped delivering wakes before a human replied");
  } finally {
    marker.dispose();
  }
}
