// The two Linear calls the halt block is handed: posting the question and
// re-reading the thread for an answer. Both reach the network, so the factory
// wraps them as steps and the block only ever sees their memoized results.

import type {
  CheckForHumanReply,
  HumanReply,
  JsonValue,
  PostNeedsHumanComment,
} from "../../blocks/ticket/halt-for-human.ts";
import {
  createComment,
  getIssueParticipants,
  listCommentsSince,
  mention,
} from "../../providers/linear.ts";

export const postNeedsHumanComment: PostNeedsHumanComment = async (
  issueId,
  reason,
  payload,
) => {
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
  console.log(
    `[postNeedsHumanComment] posted comment=${comment.id} issue=${issueId}`,
  );
  return { commentId: comment.id, postedAt: comment.createdAt };
};

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

export const checkForHumanReply: CheckForHumanReply = async (
  issueId,
  sinceIso,
  postedCommentId,
) => {
  const comments = await listCommentsSince(issueId, sinceIso);
  const cursor = comments.reduce(
    (max, comment) => (comment.createdAt > max ? comment.createdAt : max),
    sinceIso,
  );
  // A factory may run on its operator's own API key, so author identity cannot
  // tell the run's comment from the human's: exclude exactly the comment this
  // suspension posted instead.
  const human = comments.find(
    (comment) => comment.user !== null && comment.id !== postedCommentId,
  );
  console.log(
    `[checkForHumanReply] re-check issue=${issueId} since=${sinceIso} found=${human !== undefined}`,
  );
  if (human === undefined || human.user === null)
    return { reply: null, cursor };
  const reply: HumanReply = {
    commentId: human.id,
    body: human.body,
    author: human.user,
    createdAt: human.createdAt,
  };
  return { reply, cursor };
};
