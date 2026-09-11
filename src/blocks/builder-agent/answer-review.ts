// Answering review as the builder: resume-first, with a fresh-context rebuild
// that is a first-class path, never a degraded one. Both paths produce the
// same answers object, which is what makes the fallback testable as an equal
// rather than as a consolation.

import { z } from "zod";
import type { ReviewThread } from "../../providers/github.ts";
import type { readDiff } from "../../steps/pull-request/branch.ts";
import type { HarnessConfig } from "../agent/harness-config.ts";
import {
  type RebuildContextPrompt,
  rebuildContextPrompt,
} from "../agent/rebuild-context.prompt.ts";
import type { AgentSession } from "../agent/result.ts";
import {
  type AgentFn,
  type ResumeOrRebuildResult,
  resumeOrRebuild,
} from "../agent/resume-or-rebuild.ts";
import type { Handoff } from "../ticket/review.ts";
import { renderSnapshot } from "../ticket/snapshot.ts";
import {
  type AnswerReviewPrompt,
  answerReviewPrompt,
} from "./answer-review.prompt.ts";

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

export interface AnswerReviewOptions {
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
  // The words on each arm, which the factory owns: its own functions in place
  // of the ones shipped beside this block.
  resumePrompt?: AnswerReviewPrompt;
  freshPrompt?: RebuildContextPrompt;
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

export async function answerReview(
  options: AnswerReviewOptions,
): Promise<ResumeOrRebuildResult<ThreadAnswers>> {
  const { agent, readDiff: read } = options;
  const threads = renderThreads(options.threads, options.reviewBody);
  const renderResume = options.resumePrompt ?? answerReviewPrompt;
  const renderFresh = options.freshPrompt ?? rebuildContextPrompt;

  return resumeOrRebuild({
    agent,
    label: "answerReview",
    harness: options.harness,
    cwd: options.cwd,
    ...(options.session === undefined ? {} : { session: options.session }),
    resumePrompt: renderResume({ threads }),
    freshPrompt: async () => {
      const diff = await read(options.cwd, options.baseSha);
      return renderFresh({
        ticket: renderSnapshot(options.handoff.snapshot),
        brief: options.handoff.brief,
        diff,
        threads,
      });
    },
    output: threadAnswers,
  });
}
