// The halt block: post the question to the ticket, then suspend until a human
// answers. Every provider call, env read and time read lives in the two step
// implementations this block is handed — ../../steps/ticket/needs-human-comments.ts —
// so the body here only sequences memoized step results. Cursors and ids come
// from step returns, never from Date.now() or process.env.

import { createHook } from "workflow";
import { z } from "zod";
import type { TicketClaim } from "./claim.ts";

// The halt's marker hook. It names no external resource and nothing resumes
// it: the reply that ends the halt lands on the ticket claim.
export const NEEDS_HUMAN_TOKEN_PREFIX = "jigs:needs-human:";

export function needsHumanToken(issueId: string, commentId: string): string {
  return `${NEEDS_HUMAN_TOKEN_PREFIX}${issueId}:${commentId}`;
}

/** Interpolated into a prompt or a comment; never rendered as one. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// Declared as zod rather than as a bare type so a model step can emit a
// question directly, as ticket review does.
export const haltOption = z.strictObject({
  label: z.string().min(1),
  recommended: z.boolean().optional(),
});

export const haltQuestion = z.strictObject({
  question: z.string().min(1),
  context: z.string().optional(),
  options: z.array(haltOption).optional(),
});

export type HaltOption = z.infer<typeof haltOption>;
export type HaltQuestion = z.infer<typeof haltQuestion>;

/**
 * What the ticket comment says, in the words a stranger to the repo reads.
 * `headline` is one plain sentence naming what jigs paused and why, `where`
 * names the block it paused in so the footer can say so, `about` restates the
 * ticket itself, `notes` are plain bullet lines, and `onReply` decides what
 * the comment asks the human to do: choose between the questions ("continue")
 * or repair something and let the step run again ("retry").
 */
export type Halt = {
  headline: string;
  where: string;
  about?: string;
  questions?: HaltQuestion[];
  notes?: string[];
  onReply: "continue" | "retry";
};

export interface HumanReply {
  commentId: string;
  body: string;
  author: { id: string; name: string };
  createdAt: string;
}

// Declared here rather than written as `typeof postComment`:
// declaring the contract block-side typechecks the step against the block and
// keeps this side free of any value import into steps/.
export type PostComment = (
  issueId: string,
  halt: Halt,
) => Promise<{ commentId: string; postedAt: string }>;

export type CheckForReply = (
  issueId: string,
  sinceIso: string,
  postedCommentId: string,
) => Promise<{ reply: HumanReply | null; cursor: string }>;

export type HaltForHumanDeps = {
  postComment: PostComment;
  checkForReply: CheckForReply;
};

/** {@link haltForHuman} with its steps already bound — what a block is handed. */
export type HaltForHumanFn = (claim: TicketClaim, halt: Halt) => Promise<HumanReply>;

// Posts the halt to the Linear ticket (@-mentioning its creator and assignee),
// then suspends on the claim hook. Wakes are hints: each one re-checks the
// actual comment thread and re-suspends when no human has replied — no agent
// step executes on an unsatisfied wake.
export async function haltForHuman(
  claim: TicketClaim,
  halt: Halt,
  deps: HaltForHumanDeps,
): Promise<HumanReply> {
  // Destructured, never invoked as `deps.postComment(...)`: the SDK
  // serializes a step call's receiver along with its arguments, and this
  // object holds functions.
  const { checkForReply, postComment } = deps;
  const posted = await postComment(claim.issueId, halt);
  // The halt's only signal: the claim hook is held for the run's whole life,
  // so this marker is what tells `jigs ps` the run is parked on a human. Never
  // awaited — it registers when the run suspends on the claim hook below.
  const marker = createHook<never>({
    token: needsHumanToken(claim.issueId, posted.commentId),
  });
  try {
    let cursor = posted.postedAt;
    for await (const _hint of claim.hook) {
      const check = await checkForReply(claim.issueId, cursor, posted.commentId);
      if (check.reply !== null) return check.reply;
      cursor = check.cursor;
    }
    throw new Error("claim hook stopped delivering wakes before a human replied");
  } finally {
    marker.dispose();
  }
}
