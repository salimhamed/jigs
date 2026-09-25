import { defineWorkflow, JigsError, type WorkflowInputs } from "@jigs-ai/jigs";
import {
  type Harness,
  type HarnessKind,
  harnesses,
  harnessKinds,
} from "@jigs-ai/jigs/blocks/agents";
import { z } from "zod";
import { noteOnTicket, release, reviewTicket } from "#jigs/routines";
import { provisionWorktree, resolveMergePolicy, setTicketStatus } from "#jigs/steps";
import { deliverChange } from "../blocks/delivery/delivery.ts";
import { acquireLinearTicket, workItemFromHandoff } from "../blocks/tickets/linear.ts";

// The harnesses a run can choose by name, each with this factory's default
// model. A model input left unset takes the default of the harness that was
// actually chosen, so naming one never drags the other's default along. Pass
// `effort` beside the model to tune a harness; omit it to keep that
// provider's default. A harness missing here, such as Pi, needs a model
// source rather than a model name: build its role below with `harnesses.pi`.
const inputHarnesses: Partial<Record<HarnessKind, (model?: string) => Harness>> = {
  claude: (model = "opus") => harnesses.claude(model),
  codex: (model = "gpt-5.6-sol") => harnesses.codex(model),
};

function unbuildable(kind: HarnessKind) {
  return `linear-ticket-to-pr cannot build a ${kind} role from its inputs: ${kind} roles need a model source and are configured in the linear-ticket-to-pr workflow's own code`;
}

function roleHarness(kind: HarnessKind, model?: string): Harness {
  const build = inputHarnesses[kind];
  if (build === undefined) throw new JigsError(unbuildable(kind));
  return build(model);
}

// Every harness a run can choose, at its default model. The service checks
// each one's CLI before a run starts.
const agents = { claude: roleHarness("claude"), codex: roleHarness("codex") };

const harnessInput = z.enum(harnessKinds).refine((kind) => inputHarnesses[kind] !== undefined, {
  error: (issue) => unbuildable(issue.input as HarnessKind),
});

export const linearTicketToPrInputs = z.object({
  ticket: z.string().min(1),
  binding: z.string(),
  implementationHarness: harnessInput.default("codex"),
  implementationModel: z.string().min(1).optional(),
  reviewHarness: harnessInput.default("claude"),
  reviewModel: z.string().min(1).optional(),
  implementationReviewRounds: z.number().int().positive().default(3),
  ciFixAttempts: z.number().int().nonnegative().default(3),
  pullRequestRevisionRounds: z.number().int().nonnegative().default(3),
});

type LinearTicketToPrInputs = WorkflowInputs<typeof linearTicketToPrInputs>;

/** Take a Linear ticket through implementation, review, and pull-request merge. */
export async function linearTicketToPrWorkflow(inputs: LinearTicketToPrInputs) {
  "use workflow";

  const { claim, snapshot } = await acquireLinearTicket(inputs.ticket);
  await setTicketStatus(snapshot.id, "In Progress");
  const worktree = await provisionWorktree({
    binding: inputs.binding,
    branch: snapshot.branchName,
  });
  const handoff = await reviewTicket({
    claim,
    snapshot,
    harness: roleHarness("claude"),
    cwd: worktree.path,
  });
  const result = await deliverChange({
    task: workItemFromHandoff(handoff),
    worktree,
    binding: inputs.binding,
    implementation: {
      harness: roleHarness(inputs.implementationHarness, inputs.implementationModel),
    },
    review: { harness: roleHarness(inputs.reviewHarness, inputs.reviewModel) },
    limits: {
      implementationReviewRounds: inputs.implementationReviewRounds,
      ciFixAttempts: inputs.ciFixAttempts,
      pullRequestRevisionRounds: inputs.pullRequestRevisionRounds,
    },
    merge: await resolveMergePolicy(inputs.binding),
    postNote: (note) => noteOnTicket(claim, note),
    on: {
      pullRequestOpened: async () => {
        await setTicketStatus(snapshot.id, "In Review");
      },
      merged: async (pr) => {
        await setTicketStatus(snapshot.id, "Done");
        await noteOnTicket(claim, {
          headline: `jigs finished work on ${snapshot.identifier}.`,
          notes: [`Merged in ${pr.owner}/${pr.repo}#${pr.number}.`],
          closing: "",
        });
      },
      stopped: async () => {
        await setTicketStatus(snapshot.id, "Todo");
      },
    },
  });

  await release();
  return result;
}

export default defineWorkflow({
  inputs: linearTicketToPrInputs,
  requires: { agents, integrations: ["linear", "github"] },
  workflow: linearTicketToPrWorkflow,
});
