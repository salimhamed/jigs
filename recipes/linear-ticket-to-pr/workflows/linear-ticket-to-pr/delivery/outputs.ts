import type { ThreadAnswers } from "@jigs-ai/jigs";
import { z } from "zod";

// threadId null means the pull request conversation: a review body has no
// thread root to reply into.
export const threadAnswers = z.strictObject({
  answers: z.array(
    z.strictObject({
      threadId: z.number().int().nullable(),
      body: z.string().min(1),
    }),
  ),
  commitExplanation: z.string().min(1).nullable(),
}) satisfies z.ZodType<ThreadAnswers>;

export type { ThreadAnswers } from "@jigs-ai/jigs";

export const pullRequestDescription = z.strictObject({
  title: z.string().min(1),
  body: z.string().min(1),
});

export type PullRequestDescription = z.output<typeof pullRequestDescription>;
