// Answering review as the builder (ADR 0009): resume-first, with a
// fresh-context rebuild that is a first-class path, never a degraded one.
// Both paths produce the same answers object, which is what makes the
// fallback testable as an equal rather than as a consolation.

import {
  answerReviewPrompt,
  interpolate,
  rebuildContextPrompt,
} from "@salimhamed/jigs/prompts";
import type { AgentSession, HarnessConfig } from "@salimhamed/jigs/steps";
import { z } from "zod";
import type { ReviewThread } from "../providers/github";
import {
  type AgentFn,
  type ResumeOrRebuildResult,
  resumeOrRebuild,
} from "../steps";
import type { Handoff } from "../ticket/review";
import { renderSnapshot } from "../ticket/snapshot";
import type { readDiff } from "./pull-request";

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
  harness: HarnessConfig;
  cwd: string;
  session?: AgentSession;
  threads: ReviewThread[];
  // A review body arrives without a thread root of its own.
  reviewBody?: string;
  handoff: Handoff;
  baseSha: string;
}

export type BuilderDeps = {
  agent: AgentFn;
  readDiff: typeof readDiff;
};

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
  deps: BuilderDeps,
): Promise<ResumeOrRebuildResult<ThreadAnswers>> {
  const threads = renderThreads(options.threads, options.reviewBody);

  return resumeOrRebuild({
    agent: deps.agent,
    label: "reviewLoop",
    harness: options.harness,
    cwd: options.cwd,
    ...(options.session === undefined ? {} : { session: options.session }),
    resumePrompt: interpolate(answerReviewPrompt, { THREADS: threads }),
    freshPrompt: async () => {
      // Destructured, never invoked as `deps.readDiff(...)`: the SDK
      // serializes a step call's receiver along with its arguments, and this
      // object holds functions.
      const { readDiff: read } = deps;
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
