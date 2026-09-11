// The Linear calls the halt block is handed: posting the question and
// re-reading the thread for an answer, plus the non-blocking note a ticket
// review posts when it proceeds on assumptions. All three reach the network,
// so the factory wraps them as steps and a block only ever sees their
// memoized results.
//
// The comment's markdown is a template rendered here rather than a string
// built in TypeScript, for the same reason a prompt is: a template is a file,
// and a factory that wants a different-looking comment registers its own
// `needs-human-comment` instead of replacing the step.

import type {
  CheckForHumanReply,
  Halt,
  HumanReply,
  PostNeedsHumanComment,
} from "../../blocks/ticket/halt-for-human.ts";
import type { TicketNote } from "../../blocks/ticket/review.ts";
import {
  createComment,
  getIssueParticipants,
  type LinearUser,
  listCommentsSince,
  mention,
} from "../../providers/linear.ts";
import { jigsPrompts } from "../prompts/jigs-prompts.ts";
import type { PromptData, PromptRegistry } from "../prompts/registry.ts";

const NEEDS_HUMAN_COMMENT = "needs-human-comment";
const PROCEEDING_NOTE = "proceeding-note";

/**
 * What the comment's footer says about the run that posted it. The factory's
 * step wrapper builds it: the run id and the pipeline name come from the
 * Workflow SDK's metadata, and the dashboard link from the service's own
 * configuration — none of it visible to a block.
 */
export type NeedsHumanContext = {
  runId: string;
  pipeline?: string;
  pausedAt: string;
  dashboardUrl?: string;
};

// Creator and assignee, in that order, each named once. Either may be absent;
// a ticket nobody created and nobody owns gets no greeting rather than a
// dangling dash.
async function mentions(issueId: string): Promise<string> {
  const { creator, assignee } = await getIssueParticipants(issueId);
  const seen = new Set<string>();
  const people: LinearUser[] = [];
  for (const user of [creator, assignee]) {
    if (user === null || seen.has(user.id)) continue;
    seen.add(user.id);
    people.push(user);
  }
  return people.map(mention).join(" ");
}

export const postNeedsHumanComment = async (
  issueId: string,
  halt: Halt,
  context: NeedsHumanContext,
  prompts: PromptRegistry = jigsPrompts,
): ReturnType<PostNeedsHumanComment> => {
  const data: PromptData = {
    MENTIONS: await mentions(issueId),
    HEADLINE: halt.headline,
    ABOUT: halt.about ?? "",
    ON_REPLY: halt.onReply,
    QUESTIONS: (halt.questions ?? []).map((question) => ({
      question: question.question,
      context: question.context ?? "",
      options: (question.options ?? []).map((option) => ({
        label: option.label,
        recommended: option.recommended ?? false,
      })),
    })),
    NOTES: halt.notes ?? [],
    RUN_ID: context.runId,
    PIPELINE: context.pipeline ?? "",
    PAUSED_AT: context.pausedAt,
    DASHBOARD_URL: context.dashboardUrl ?? "",
  };
  const comment = await createComment(
    issueId,
    prompts.render(NEEDS_HUMAN_COMMENT, data),
  );
  console.log(
    `[postNeedsHumanComment] posted comment=${comment.id} issue=${issueId}`,
  );
  return { commentId: comment.id, postedAt: comment.createdAt };
};

export const postTicketNote = async (
  issueId: string,
  note: TicketNote,
  prompts: PromptRegistry = jigsPrompts,
): Promise<void> => {
  const comment = await createComment(
    issueId,
    prompts.render(PROCEEDING_NOTE, {
      MENTIONS: await mentions(issueId),
      IDENTIFIER: note.identifier,
      ASSUMPTIONS: note.assumptions,
    }),
  );
  console.log(`[postTicketNote] posted comment=${comment.id} issue=${issueId}`);
};

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
