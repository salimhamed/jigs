// The halt block: post the reason to the ticket, then suspend until a human
// answers. Every provider call, env read and time read lives in the two step
// implementations this block is handed — ../../steps/ticket/needs-human-comments.ts —
// so the body here only sequences memoized step results. Cursors and ids come
// from step returns, never from Date.now() or process.env.

import { createHook } from "workflow";
import type { TicketClaim } from "./claim.ts";

// The halt's marker hook. It names no external resource and nothing resumes
// it: the reply that ends the halt lands on the ticket claim.
export const NEEDS_HUMAN_TOKEN_PREFIX = "jigs:needs-human:";

export function needsHumanToken(issueId: string, commentId: string): string {
  return `${NEEDS_HUMAN_TOKEN_PREFIX}${issueId}:${commentId}`;
}

// The extra detail a halt posts to the ticket beneath its reason.
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface HumanReply {
  commentId: string;
  body: string;
  author: { id: string; name: string };
  createdAt: string;
}

// Declared here rather than written as `typeof postNeedsHumanComment`: the
// implementation lives under steps/ and reaches Linear, and a block naming it
// even in a type position is an import edge this side may not have.
export type PostNeedsHumanComment = (
  issueId: string,
  reason: string,
  payload: JsonValue | undefined,
) => Promise<{ commentId: string; postedAt: string }>;

export type CheckForHumanReply = (
  issueId: string,
  sinceIso: string,
  postedCommentId: string,
) => Promise<{ reply: HumanReply | null; cursor: string }>;

export type NeedsHumanDeps = {
  postComment: PostNeedsHumanComment;
  checkForReply: CheckForHumanReply;
};

/** {@link needsHuman} with its steps already bound — what a jig is handed. */
export type NeedsHumanFn = (
  claim: TicketClaim,
  reason: string,
  payload?: JsonValue,
) => Promise<HumanReply>;

// Posts the reason to the Linear ticket (@-mentioning its creator), then
// suspends on the claim hook. Wakes are hints: each one re-checks the actual
// comment thread and re-suspends when no human has replied — no agent step
// executes on an unsatisfied wake.
export async function needsHuman(
  claim: TicketClaim,
  reason: string,
  payload: JsonValue | undefined,
  deps: NeedsHumanDeps,
): Promise<HumanReply> {
  // Destructured, never invoked as `deps.postComment(...)`: the SDK
  // serializes a step call's receiver along with its arguments, and this
  // object holds functions.
  const { checkForReply, postComment } = deps;
  const posted = await postComment(claim.issueId, reason, payload);
  // The halt's only signal: the claim hook is held for the run's whole life,
  // so this marker is what tells `jigs ps` the run is parked on a human. Never
  // awaited — it registers when the run suspends on the claim hook below.
  const marker = createHook<never>({
    token: needsHumanToken(claim.issueId, posted.commentId),
  });
  try {
    let cursor = posted.postedAt;
    for await (const _hint of claim.hook) {
      const check = await checkForReply(
        claim.issueId,
        cursor,
        posted.commentId,
      );
      if (check.reply !== null) return check.reply;
      cursor = check.cursor;
    }
    throw new Error(
      "claim hook stopped delivering wakes before a human replied",
    );
  } finally {
    marker.dispose();
  }
}
