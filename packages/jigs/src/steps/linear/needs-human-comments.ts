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

import { createHash } from "node:crypto";
import { type LinearClient, linearFor } from "../../providers/linear.ts";
import type { FactoryDefinition } from "../../workflow/factory.ts";
import type {
  CheckForTicketHumanReply,
  HumanReply,
  PostTicketHumanInputRequest,
} from "../../workflow/linear/halt-for-human.ts";
import type { PostTicketNote } from "../../workflow/linear/review.ts";
import { dashboardRunUrl, type StepRunMetadata } from "../runtime/run-context.ts";
import { resolveParticipants } from "./mentions.ts";
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
 * Mentions the factory's `linear.operator`, or the ticket's creator when it is
 * not set, then the assignee and the halt's `mention` emails, each person once.
 * A person Linear cannot find is skipped with a warning; the comment always
 * posts. `definition` is the built factory definition the step wrapper passes
 * in, so a changed operator takes effect after a rebuild, which `jigs up` does.
 *
 * @group Human interaction primitives
 */
export const postTicketHumanInputRequest = async (
  { installationName, issueId, halt }: Parameters<PostTicketHumanInputRequest>[0],
  metadata: StepRunMetadata,
  definition: FactoryDefinition,
  render: RenderNeedsHumanComment = renderNeedsHumanComment,
): ReturnType<PostTicketHumanInputRequest> => {
  const context: NeedsHumanContext = {
    runId: metadata.workflowRunId,
    workflow: metadata.workflowName,
    dashboardUrl: dashboardRunUrl(metadata.workflowRunId),
  };
  const linear = linearFor(installationName);
  const comment = await postOnce(linear, stepPostingId(metadata, issueId), issueId, async () => {
    const participants = await resolveParticipants(linear, issueId, {
      operator: definition.linear?.operator,
      mention: halt.mention,
    });
    return render(halt, context, participants);
  });
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
  { installationName, issueId, note }: Parameters<PostTicketNote>[0],
  metadata: StepRunMetadata,
  definition: FactoryDefinition,
  render: RenderTicketNote = renderTicketNote,
): ReturnType<PostTicketNote> => {
  const linear = linearFor(installationName);
  const comment = await postOnce(linear, stepPostingId(metadata, issueId), issueId, async () => {
    const participants = await resolveParticipants(linear, issueId, {
      operator: definition.linear?.operator,
      mention: note.mention,
    });
    return render(note, participants);
  });
  console.log(`[postTicketNote] posted comment=${comment.id} issue=${issueId}`);
  return { commentId: comment.id };
};

/**
 * The id a step's post is created under: a UUID v4 derived from the run, the step and where it
 * posts, so every retry of one step names the same post while two posts of the same text stay two.
 */
export function stepPostingId(metadata: StepRunMetadata, target: string): string {
  const hex = createHash("sha256")
    .update(JSON.stringify([metadata.workflowRunId, metadata.stepId, target]))
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "4";
  hex[16] = "89ab"[Number.parseInt(hex[16] ?? "0", 16) % 4] ?? "8";
  const id = hex.join("");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

// A step retry may follow a create whose response was lost. The comment then
// already exists under this id, and creating it again would either post a
// duplicate or fail on the id, so look first and look again after a failure.
async function postOnce(
  linear: LinearClient,
  id: string,
  issueId: string,
  body: () => Promise<string>,
): Promise<{ id: string; createdAt: string }> {
  const existing = await linear.findComment(id);
  if (existing !== null) return existing;
  try {
    return await linear.createComment(issueId, await body(), id);
  } catch (error) {
    const created = await linear.findComment(id).catch(() => null);
    if (created !== null) return created;
    throw error;
  }
}

/**
 * Look for a reply since the last check, excluding every comment the run posted.
 *
 * @group Human interaction primitives
 */
export const checkForTicketHumanReply: CheckForTicketHumanReply = async ({
  installationName,
  issueId,
  since: sinceIso,
  postedCommentIds,
}) => {
  const linear = linearFor(installationName);
  const [comments, app] = await Promise.all([
    linear.listCommentsSince(issueId, sinceIso),
    linear.appUser(),
  ]);
  const cursor = comments.reduce(
    (max, comment) => (comment.createdAt > max ? comment.createdAt : max),
    sinceIso,
  );
  // Anything the factory's app wrote is not a human's answer, whichever run
  // posted it.
  const human = comments.find(
    (comment) =>
      comment.user !== null && comment.user.id !== app.id && !postedCommentIds.includes(comment.id),
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
