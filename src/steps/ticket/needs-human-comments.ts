// The Linear calls the halt block is handed: posting the question and
// re-reading the thread for an answer, plus the non-blocking note a ticket
// review posts when it proceeds on assumptions. All three reach the network,
// so the factory wraps them as steps and a block only ever sees their
// memoized results.
//
// The markdown itself lives in ./render-comment.ts. Each posting step takes
// its renderer as an optional argument, so a factory that wants a
// different-looking comment passes its own function from its step wrapper and
// replaces no step.

import type {
  CheckForHumanReply,
  Halt,
  HumanReply,
  PostNeedsHumanComment,
} from "../../blocks/ticket/halt-for-human.ts";
import type { TicketNote } from "../../blocks/ticket/review.ts";
import { createComment, getIssueParticipants, listCommentsSince } from "../../providers/linear.ts";
import { dashboardRunUrl, type NamedRunMetadata } from "../run-context.ts";
import {
  type NeedsHumanContext,
  type RenderNeedsHumanComment,
  type RenderProceedingNote,
  renderNeedsHumanComment,
  renderProceedingNote,
} from "./render-comment.ts";

/** Post a question or failure on the ticket so a person can help the run continue. */
export const postNeedsHumanComment = async (
  issueId: string,
  halt: Halt,
  metadata: NamedRunMetadata,
  render: RenderNeedsHumanComment = renderNeedsHumanComment,
): ReturnType<PostNeedsHumanComment> => {
  const context: NeedsHumanContext = {
    runId: metadata.workflowRunId,
    workflow: metadata.workflowName,
    dashboardUrl: dashboardRunUrl(metadata.workflowRunId),
  };
  const participants = await getIssueParticipants(issueId);
  const comment = await createComment(issueId, render(halt, context, participants));
  console.log(`[postNeedsHumanComment] posted comment=${comment.id} issue=${issueId}`);
  return { commentId: comment.id, postedAt: comment.createdAt };
};

/** Tell ticket participants which assumptions the run is proceeding with. */
export const postTicketNote = async (
  issueId: string,
  note: TicketNote,
  render: RenderProceedingNote = renderProceedingNote,
): Promise<void> => {
  const participants = await getIssueParticipants(issueId);
  const comment = await createComment(issueId, render(note, participants));
  console.log(`[postTicketNote] posted comment=${comment.id} issue=${issueId}`);
};

/** Look for a reply since the last check, excluding the run’s own question. */
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
  const human = comments.find((comment) => comment.user !== null && comment.id !== postedCommentId);
  console.log(
    `[checkForHumanReply] re-check issue=${issueId} since=${sinceIso} found=${human !== undefined}`,
  );
  if (human === undefined || human.user === null) return { reply: null, cursor };
  const reply: HumanReply = {
    commentId: human.id,
    body: human.body,
    author: human.user,
    createdAt: human.createdAt,
  };
  return { reply, cursor };
};
