// The Linear calls the halt routine is handed: posting the question and
// re-reading the thread for an answer, plus the non-blocking note a ticket
// review posts when it proceeds on assumptions. All three reach the network,
// so the factory wraps them as steps and a routine only ever sees their
// memoized results.
//
// The markdown itself lives in ./render-comment.ts. Each posting step takes
// its renderer as an optional argument, so a factory that wants a
// different-looking comment passes its own function from its step wrapper and
// replaces no step.

import { createComment, listCommentsSince } from "../../providers/linear.ts";
import type { FactoryDefinition } from "../../workflow/factory.ts";
import type {
  CheckForTicketHumanReply,
  Halt,
  HumanReply,
  PostTicketHumanInputRequest,
} from "../../workflow/linear/halt-for-human.ts";
import type { PostTicketNote, TicketNote } from "../../workflow/linear/review.ts";
import { dashboardRunUrl, type NamedRunMetadata } from "../runtime/run-context.ts";
import { resolveParticipants, runOperator } from "./mentions.ts";
import {
  type NeedsHumanContext,
  type RenderNeedsHumanComment,
  type RenderTicketNote,
  renderNeedsHumanComment,
  renderTicketNote,
} from "./render-comment.ts";

/**
 * Post a question or failure on the ticket so a person can help the run continue.
 *
 * @remarks
 * Mentions the operator (the workflow's `linear.operator`, else the factory's),
 * or the ticket's creator when neither is set, then the assignee and the halt's
 * `mention` emails, each person once. A person Linear cannot find is skipped
 * with a warning; the comment always posts.
 *
 * @group Human interaction primitives
 */
export const postTicketHumanInputRequest = async (
  issueId: string,
  halt: Halt,
  metadata: NamedRunMetadata,
  definition: FactoryDefinition,
  render: RenderNeedsHumanComment = renderNeedsHumanComment,
): ReturnType<PostTicketHumanInputRequest> => {
  const context: NeedsHumanContext = {
    runId: metadata.workflowRunId,
    workflow: metadata.workflowName,
    dashboardUrl: dashboardRunUrl(metadata.workflowRunId),
  };
  const participants = await resolveParticipants(issueId, {
    operator: await runOperator(metadata, definition),
    mention: halt.mention,
  });
  const comment = await createComment(issueId, render(halt, context, participants));
  console.log(`[postTicketHumanInputRequest] posted comment=${comment.id} issue=${issueId}`);
  return { commentId: comment.id, postedAt: comment.createdAt };
};

/**
 * Tell ticket participants something the run decided, without waiting for a reply.
 *
 * @remarks
 * Mentions the same people as {@link postTicketHumanInputRequest}, with the
 * note's `mention` emails as the extras.
 *
 * @group Human interaction primitives
 */
export const postTicketNote = async (
  issueId: string,
  note: TicketNote,
  metadata: NamedRunMetadata,
  definition: FactoryDefinition,
  render: RenderTicketNote = renderTicketNote,
): ReturnType<PostTicketNote> => {
  const participants = await resolveParticipants(issueId, {
    operator: await runOperator(metadata, definition),
    mention: note.mention,
  });
  const comment = await createComment(issueId, render(note, participants));
  console.log(`[postTicketNote] posted comment=${comment.id} issue=${issueId}`);
  return { commentId: comment.id };
};

/**
 * Look for a reply since the last check, excluding every comment the run posted.
 *
 * @group Human interaction primitives
 */
export const checkForTicketHumanReply: CheckForTicketHumanReply = async (
  issueId,
  sinceIso,
  postedCommentIds,
) => {
  const comments = await listCommentsSince(issueId, sinceIso);
  const cursor = comments.reduce(
    (max, comment) => (comment.createdAt > max ? comment.createdAt : max),
    sinceIso,
  );
  // The factory may act as its operator, so author identity cannot tell jigs'
  // comments from the human's: exclude, by id, every comment the run posted.
  const human = comments.find(
    (comment) => comment.user !== null && !postedCommentIds.includes(comment.id),
  );
  console.log(
    `[checkForTicketHumanReply] re-check issue=${issueId} since=${sinceIso} found=${human !== undefined}`,
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
