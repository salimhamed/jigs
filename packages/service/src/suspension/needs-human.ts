// Determinism rule for this module: every provider call, env read, and time
// read lives in one of the two implementation functions below, which the
// factory wraps as steps and injects. The workflow body only sequences
// memoized step results — cursors and ids come from step returns, never from
// Date.now() or process.env in the body.

import { createHook } from "workflow";
import {
  createComment,
  getIssueParticipants,
  listCommentsSince,
  mention,
} from "../providers/linear";
import type { TicketClaim } from "./claim";
import { type JsonValue, suspensionMetadata } from "./record";

export interface HumanReply {
  commentId: string;
  body: string;
  author: { id: string; name: string };
  createdAt: string;
}

export type NeedsHumanDeps = {
  postComment: typeof postNeedsHumanComment;
  checkForReply: typeof checkForHumanReply;
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
  // Marker hook: carries the needs-human record for run inspection. Never
  // awaited — it registers when the run suspends on the claim hook below.
  const marker = createHook<never>({
    token: `jigs:suspension:${claim.issueId}:${posted.commentId}`,
    metadata: suspensionMetadata({
      key: `needs-human:${posted.commentId}`,
      reason,
      payload,
      satisfiedBy: claim.token,
    }),
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

export async function postNeedsHumanComment(
  issueId: string,
  reason: string,
  payload: JsonValue | undefined,
) {
  const { creator } = await getIssueParticipants(issueId);
  const lines = [`${creator !== null ? `${mention(creator)} ` : ""}${reason}`];
  if (payload !== undefined) {
    if (isFindingsPayload(payload)) {
      lines.push("", ...payload.findings.map((finding) => `1. ${finding}`));
    } else {
      lines.push("", "```json", JSON.stringify(payload, null, 2), "```");
    }
  }
  const comment = await createComment(issueId, lines.join("\n"));
  console.log(`[needsHuman] posted comment=${comment.id} issue=${issueId}`);
  return { commentId: comment.id, postedAt: comment.createdAt };
}

function isFindingsPayload(
  payload: JsonValue,
): payload is { findings: string[] } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    Object.keys(payload).length === 1 &&
    Array.isArray(payload.findings) &&
    payload.findings.every((finding) => typeof finding === "string")
  );
}

export async function checkForHumanReply(
  issueId: string,
  sinceIso: string,
  postedCommentId: string,
): Promise<{ reply: HumanReply | null; cursor: string }> {
  const comments = await listCommentsSince(issueId, sinceIso);
  const cursor = comments.reduce(
    (max, comment) => (comment.createdAt > max ? comment.createdAt : max),
    sinceIso,
  );
  // A factory may run on its operator's own API key, so author identity
  // cannot tell the run's comment from the human's (AGE-349): exclude
  // exactly the comment this suspension posted instead.
  const human = comments.find(
    (comment) => comment.user !== null && comment.id !== postedCommentId,
  );
  console.log(
    `[needsHuman] re-check issue=${issueId} since=${sinceIso} found=${human !== undefined}`,
  );
  if (human === undefined || human.user === null)
    return { reply: null, cursor };
  return {
    reply: {
      commentId: human.id,
      body: human.body,
      author: human.user,
      createdAt: human.createdAt,
    },
    cursor,
  };
}
