// The type half of the per-role prompt contexts. A field leaking into a role
// that is never given it, or a custom task field that needs a cast to reach,
// compiles clean and only shows up in someone else's factory — so the guard
// here is tsc, through `pnpm typecheck`.

import type { Worktree } from "@jigs-ai/jigs";
import type { Harness } from "@jigs-ai/jigs/blocks/agents";
import { expect, test } from "vitest";
import * as delivery from "./delivery.ts";
import type {
  CiRepairPromptContext,
  DescriptionPromptContext,
  ImplementationPromptContext,
  ReviewPromptContext,
} from "./types.ts";

declare const worktree: Worktree;
declare const harness: Harness;

const incident = {
  id: "68bc9696-35d5-442d-ab56-214c8cfefbec",
  key: "storage-1",
  title: "Repair search",
  instructions: "Find exact matches",
  service: "bucket-a",
};

/** No explicit generic argument and no cast, from the context or the result. */
async function customTaskFieldsAreReachable(): Promise<string> {
  const result = await delivery.deliverChange({
    task: incident,
    worktree,
    binding: "application",
    implementation: { harness, prompt: (context) => context.task.service },
    review: { harness, prompt: (context) => `${context.task.service} ${context.headCommit}` },
    limits: { implementationReviewRounds: 1, ciFixAttempts: 1, pullRequestRevisionRounds: 1 },
    merge: { by: "human", method: "squash", approval: { kind: "review" } },
    onLimit: async (limit) => ({
      action: "continue",
      instructions: limit.task.service,
      additionalAttempts: 1,
    }),
  });
  return result.change.task.service;
}

function reviewIsNeverGivenFailingChecks(context: ReviewPromptContext): unknown {
  // @ts-expect-error failing checks belong to the CI repair role
  return context.failing;
}

function implementationIsNeverGivenTheHeadCommit(context: ImplementationPromptContext): unknown {
  // @ts-expect-error the reviewed head commit belongs to the review role
  return context.headCommit;
}

function ciRepairIsNeverGivenReviewThreads(context: CiRepairPromptContext): unknown {
  // @ts-expect-error review threads belong to the pull-request revision role
  return context.threads;
}

function implementationIsNeverGivenReviewThreads(context: ImplementationPromptContext): unknown {
  // @ts-expect-error review threads belong to the pull-request revision role
  return context.threads;
}

/** Every role renders the default it would otherwise have been sent. */
function descriptionRendersTheShippedDefault(
  context: DescriptionPromptContext,
): () => Promise<string> {
  return context.renderDefaultPrompt;
}

test("each role's context exposes only what its operation supplies", () => {
  expect([
    customTaskFieldsAreReachable,
    reviewIsNeverGivenFailingChecks,
    implementationIsNeverGivenTheHeadCommit,
    ciRepairIsNeverGivenReviewThreads,
    implementationIsNeverGivenReviewThreads,
    descriptionRendersTheShippedDefault,
  ]).toHaveLength(6);
});
