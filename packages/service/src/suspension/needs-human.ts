// Determinism rule for this module: every provider call, env read, and time
// read lives inside a "use step" function. The workflow body only sequences
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

// Posts the reason to the Linear ticket (@-mentioning its creator), then
// suspends on the claim hook. Wakes are hints: each one re-checks the actual
// comment thread and re-suspends when no human has replied — no agent step
// executes on an unsatisfied wake.
export async function needsHuman(
  claim: TicketClaim,
  reason: string,
  payload?: JsonValue,
): Promise<HumanReply> {
  const posted = await postNeedsHumanComment(claim.issueId, reason, payload);
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
      const check = await checkForHumanReply(
        claim.issueId,
        cursor,
        posted.viewerId,
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

async function postNeedsHumanComment(
  issueId: string,
  reason: string,
  payload: JsonValue | undefined,
) {
  "use step";
  const { creator, viewerId } = await getIssueParticipants(issueId);
  const lines = [
    `${creator !== null ? `${mention(creator)} ` : ""}this run needs a human.`,
    "",
    `**Reason:** ${reason}`,
  ];
  if (payload !== undefined) {
    lines.push("", "```json", JSON.stringify(payload, null, 2), "```");
  }
  const comment = await createComment(issueId, lines.join("\n"));
  console.log(`[needsHuman] posted comment=${comment.id} issue=${issueId}`);
  return { commentId: comment.id, postedAt: comment.createdAt, viewerId };
}

async function checkForHumanReply(
  issueId: string,
  sinceIso: string,
  viewerId: string,
): Promise<{ reply: HumanReply | null; cursor: string }> {
  "use step";
  const comments = await listCommentsSince(issueId, sinceIso);
  const cursor = comments.reduce(
    (max, comment) => (comment.createdAt > max ? comment.createdAt : max),
    sinceIso,
  );
  const human = comments.find(
    (comment) => comment.user !== null && comment.user.id !== viewerId,
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
