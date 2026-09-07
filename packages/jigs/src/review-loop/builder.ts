// Answering review as the builder: resume-first, with a fresh-context rebuild
// that is a first-class path, never a degraded one. Both paths produce the
// same answers object, which is what makes the fallback testable as an equal
// rather than as a consolation.

import { z } from "zod";
import {
  answerReviewPrompt,
  interpolate,
  rebuildContextPrompt,
} from "../prompts/index.ts";
import type { PrRef, ReviewThread } from "../providers/github.ts";
import type { AgentSession, HarnessConfig } from "../steps/index.ts";
import {
  type AgentFn,
  type ResumeOrRebuildResult,
  resumeOrRebuild,
} from "../steps/index.ts";
import type { Handoff } from "../ticket/review.ts";
import { renderSnapshot } from "../ticket/snapshot.ts";
import type { commentOnPr, readDiff, replyInThread } from "./pull-request.ts";

// threadId null means the pull request conversation: a review body has no
// thread root to reply into.
export const threadAnswers = z.strictObject({
  answers: z.array(
    z.strictObject({
      threadId: z.number().int().nullable(),
      body: z.string().min(1),
    }),
  ),
});

export type ThreadAnswers = z.output<typeof threadAnswers>;

export interface AnswerAsBuilderOptions {
  agent: AgentFn;
  readDiff: typeof readDiff;
  harness: HarnessConfig;
  cwd: string;
  session?: AgentSession;
  threads: ReviewThread[];
  // A review body arrives without a thread root of its own.
  reviewBody?: string;
  handoff: Handoff;
  baseSha: string;
}

function renderThreads(threads: ReviewThread[], reviewBody?: string): string {
  const blocks = threads.map((thread) => {
    const where =
      thread.line === null
        ? thread.path
        : `${thread.path}:${String(thread.line)}`;
    return [
      `### Thread ${thread.rootId} — ${where}`,
      "",
      ...thread.comments.map(
        (comment) => `**${comment.user}:** ${comment.body}`,
      ),
    ].join("\n");
  });
  if (reviewBody !== undefined && reviewBody !== "") {
    blocks.unshift(
      [
        "### Thread null — the pull request conversation",
        "",
        "The reviewer's summary, which has no thread of its own:",
        "",
        reviewBody,
      ].join("\n"),
    );
  }
  return blocks.length === 0 ? "_(no threads)_" : blocks.join("\n\n");
}

export async function answerAsBuilder(
  options: AnswerAsBuilderOptions,
): Promise<ResumeOrRebuildResult<ThreadAnswers>> {
  const { agent, readDiff: read } = options;
  const threads = renderThreads(options.threads, options.reviewBody);

  return resumeOrRebuild({
    agent,
    label: "answerAsBuilder",
    harness: options.harness,
    cwd: options.cwd,
    ...(options.session === undefined ? {} : { session: options.session }),
    resumePrompt: interpolate(answerReviewPrompt, { THREADS: threads }),
    freshPrompt: async () => {
      const diff = await read(options.cwd, options.baseSha);
      return interpolate(rebuildContextPrompt, {
        TICKET: renderSnapshot(options.handoff.snapshot),
        BRIEF: options.handoff.brief,
        DIFF: diff,
        THREADS: threads,
      });
    },
    output: threadAnswers,
  });
}

export interface PostAnswersOptions {
  replyInThread: typeof replyInThread;
  commentOnPr: typeof commentOnPr;
  pr: PrRef;
  answers: ThreadAnswers;
  // The wake's own threads: anything the model names outside them is invented,
  // and replying into it 404s, which burns the step's three retries.
  threads: ReviewThread[];
}

/**
 * Posts each answer where it belongs and returns the ids of the thread replies
 * — the gate cursor needs jigs' own comment ids to tell its last word on a
 * thread from a human's. Conversation comments are left out: they never appear
 * among the review threads the guard filters.
 */
export async function postAnswers(
  options: PostAnswersOptions,
): Promise<number[]> {
  const { commentOnPr: comment, replyInThread: reply, pr } = options;
  const known = new Set(options.threads.map((thread) => thread.rootId));
  const posted: number[] = [];
  for (const answer of options.answers.answers) {
    if (answer.threadId !== null && !known.has(answer.threadId)) {
      console.log(
        `[postAnswers] answer named unknown thread ${answer.threadId} — posting on the conversation instead`,
      );
    }
    if (answer.threadId === null || !known.has(answer.threadId)) {
      await comment(pr, answer.body);
    } else {
      posted.push((await reply(pr, answer.threadId, answer.body)).id);
    }
  }
  return posted;
}
