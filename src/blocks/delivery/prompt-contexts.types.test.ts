// The type half of the per-role prompt contexts. A field leaking into a role
// that is never given it, or a custom task field that needs a cast to reach,
// compiles clean and only shows up in someone else's factory — so the guard
// here is tsc, through `pnpm typecheck`.

import { expect, test } from "vitest";
import type { HarnessConfig } from "../agent/harness-config.ts";
import type { WorktreeFacts } from "../worktree.ts";
import { bindDeliverySteps } from "./review-loop.ts";
import type {
  CiRepairPromptContext,
  DeliverySteps,
  ImplementationPromptContext,
  ReviewPromptContext,
} from "./types.ts";

declare const steps: DeliverySteps;
declare const worktree: WorktreeFacts;
declare const harness: HarnessConfig;

const incident = {
  key: "storage-1",
  title: "Repair search",
  instructions: "Find exact matches",
  service: "bucket-a",
};

/** No explicit generic argument and no cast, from the context or the result. */
async function customTaskFieldsAreReachable(): Promise<string> {
  const delivery = bindDeliverySteps(steps);
  const result = await delivery.reviewLoop({
    task: incident,
    worktree,
    binding: "application",
    implementation: { harness, prompt: (context) => context.task.service },
    review: { harness, prompt: (context) => `${context.task.service} ${context.headCommit}` },
    limits: { implementationReviewRounds: 1, ciFixAttempts: 1, pullRequestRevisionRounds: 1 },
    merge: "human",
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

test("each role's context exposes only what its operation supplies", () => {
  expect([
    customTaskFieldsAreReachable,
    reviewIsNeverGivenFailingChecks,
    implementationIsNeverGivenTheHeadCommit,
    ciRepairIsNeverGivenReviewThreads,
  ]).toHaveLength(4);
});
