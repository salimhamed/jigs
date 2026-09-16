// The examples in docs/delivery.md, kept compiling by tsc. A doc example that
// does not typecheck is worse than no example: a factory author pastes it and
// the failure is theirs. Two edits from the published text. The import line: a
// factory reaches its bound operations at `#jigs`, which resolves through the
// factory's own package.json imports map and cannot resolve here, so the
// operations are declared from the binder's return type instead. And
// `onlyApprovedWorkPublishes`, which has no counterpart in the doc: it asserts
// the publication type gate the doc states in prose. Every other line is the
// doc verbatim; change one and change the other.

import { expect, test } from "vitest";
import { claude, codex, selectHarness } from "../agent/harness-config.ts";
import type { PrRef } from "../pull-request/gate.ts";
import type { MergePolicy } from "../pull-request/merge-ready.ts";
import type { TicketClaim } from "../ticket/claim.ts";
import type { HaltForHumanFn } from "../ticket/halt-for-human.ts";
import type { WorktreeFacts } from "../worktree.ts";
import type { bindDeliverySteps } from "./bind.ts";
import type {
  ApprovedChange,
  DeliveryResult,
  ImplementationAgent,
  ImplementationPromptContext,
  LimitReached,
  OnDeliveryLimit,
  ReviewAgent,
  ReviewPromptContext,
  WorkItem,
} from "./types.ts";

type Delivery = ReturnType<typeof bindDeliverySteps>;
declare const deliverChange: Delivery["deliverChange"];
declare const implementAndReview: Delivery["implementAndReview"];
declare const publishApprovedChange: Delivery["publishApprovedChange"];
declare const followPullRequest: Delivery["followPullRequest"];
declare const haltForHuman: HaltForHumanFn;
// A step rather than a bound block, so it has no place in the binder's type.
declare const resolveMergePolicy: () => Promise<MergePolicy>;

declare const task: WorkItem;
declare const worktree: WorktreeFacts;
declare const implementation: ImplementationAgent;
declare const review: ReviewAgent;
declare const checkSecurity: (change: ApprovedChange) => Promise<void>;

// "Choose agents and budgets"
async function chooseAgentsAndBudgets() {
  const result = await deliverChange({
    task,
    worktree,
    binding: "application",
    implementation: { harness: codex({ model: "gpt-5.6-sol" }) },
    review: { harness: claude({ model: "opus" }) },
    limits: {
      implementationReviewRounds: 5,
      ciFixAttempts: 3,
      pullRequestRevisionRounds: 4,
    },
    merge: await resolveMergePolicy(),
  });
  return result;
}

// "Choose agents and budgets", configuring each role independently.
async function configureEachRoleIndependently() {
  const defaultModels = { claude: "opus", codex: "gpt-5.6-sol" };

  const result = await deliverChange({
    task,
    worktree,
    binding: "application",
    implementation: { harness: selectHarness("codex", defaultModels) },
    review: { harness: selectHarness("claude", defaultModels) },
    ciRepair: { harness: codex({ model: "gpt-5.6-sol-codex" }) },
    pullRequestRevision: { harness: claude({ model: "sonnet" }) },
    pullRequestDescription: {
      harness: claude({ model: "haiku" }),
      transform: (description) => ({ ...description, title: `[factory] ${description.title}` }),
    },
    limits: {
      implementationReviewRounds: 5,
      ciFixAttempts: 3,
      pullRequestRevisionRounds: 4,
    },
    merge: await resolveMergePolicy(),
  });
  return result;
}

// "Own the prompts", extending the shipped default.
const reviewExtendingTheDefault = {
  harness: claude({ model: "opus" }),
  prompt: async (context: ReviewPromptContext) =>
    `${await context.renderDefaultPrompt()}

Also check authorization and migration compatibility.`,
};

// "Own the prompts", replacing it outright from the role's own context.
const implementationReplacingTheDefault = {
  harness: codex({ model: "gpt-5.6-sol" }),
  prompt: (context: ImplementationPromptContext) => `
Round ${context.attempt} on ${context.task.key}: ${context.task.title}

${context.task.instructions}

${context.findings.length > 0 ? `Fix these findings:\n${context.findings.join("\n")}` : "This is the first round."}
${context.instructions}

Work in ${context.worktree.path}, branched from ${context.worktree.baseSha}.
Run the repository's checks and commit before you finish: only committed work is
reviewed. Do not push and do not open a pull request.
`,
};

// "Where a human grants continuation": the halt-for-human ticket channel.
declare const claim: TicketClaim;

const onLimit = async (limit: LimitReached) => {
  const reply = await haltForHuman(claim, {
    headline: `Delivery for ${limit.task.key} has spent its ${limit.phase} budget.`,
    where: "delivery",
    about: limit.task.title,
    notes: [`${limit.attempts} attempt(s) so far.`, ...limit.findings],
    questions: [
      {
        question: "Keep going, or stop here?",
        options: [{ label: "Keep going", recommended: true }, { label: "Stop" }],
      },
    ],
    onReply: "continue",
  });
  if (/^\s*stop\b/i.test(reply.body)) return { action: "stop" as const };
  return { action: "continue" as const, instructions: reply.body, additionalAttempts: 2 };
};

const haltingOnLimit: OnDeliveryLimit = onLimit;

// "Supply your own work items": extra fields survive with no generic argument
// and no cast, into the prompt context, onLimit, and the result.
interface Incident extends WorkItem {
  service: string;
  acceptance: string[];
}

declare const incident: Incident;
declare const notifyOncall: (service: string, pr: PrRef) => Promise<void>;

async function customTaskFieldsSurvive() {
  const result = await deliverChange({
    task: incident,
    worktree,
    binding: "application",
    implementation: {
      harness: codex({ model: "gpt-5.6-sol" }),
      prompt: async (context) =>
        [
          await context.renderDefaultPrompt(),
          `Affected service: ${context.task.service}`,
          `Acceptance criteria:\n${context.task.acceptance.join("\n")}`,
        ].join("\n\n"),
    },
    review: { harness: claude({ model: "opus" }) },
    limits: {
      implementationReviewRounds: 5,
      ciFixAttempts: 3,
      pullRequestRevisionRounds: 4,
    },
    merge: await resolveMergePolicy(),
    onLimit: async (limit) => ({
      action: "continue",
      instructions: `The on-call owner of ${limit.task.service} asked for one more pass.`,
      additionalAttempts: 1,
    }),
  });

  if (result.status === "merged") {
    await notifyOncall(result.change.task.service, result.pr);
  }
}

// "Compose the phases".
async function composeThePhases(): Promise<DeliveryResult> {
  const built = await implementAndReview({
    task,
    worktree,
    implementation,
    review,
    limits: { implementationReviewRounds: 5 },
  });
  if (built.status !== "approved") return built;

  await checkSecurity(built.change);

  const pr = await publishApprovedChange({
    change: built.change,
    binding: "application",
    implementation,
  });

  return followPullRequest({
    change: built.change,
    pr,
    implementation,
    limits: { ciFixAttempts: 3, pullRequestRevisionRounds: 4 },
    merge: await resolveMergePolicy(),
  });
}

/** Publication is a type gate: a stopped result carries no approval. */
async function onlyApprovedWorkPublishes() {
  const built = await implementAndReview({
    task,
    worktree,
    implementation,
    review,
    limits: { implementationReviewRounds: 1 },
  });
  return publishApprovedChange({
    // @ts-expect-error a change that was not approved cannot be published
    change: built.change,
    binding: "application",
    implementation,
  });
}

test("every example in docs/delivery.md typechecks", () => {
  expect([
    chooseAgentsAndBudgets,
    configureEachRoleIndependently,
    reviewExtendingTheDefault,
    implementationReplacingTheDefault,
    haltingOnLimit,
    customTaskFieldsSurvive,
    composeThePhases,
    onlyApprovedWorkPublishes,
  ]).toHaveLength(8);
});
