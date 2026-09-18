import type { WorkflowEntry, WorkflowInputs } from "@salimhamed/jigs";
import { claude, selectHarness } from "@salimhamed/jigs/agents";
import { z } from "zod";
import { deliverChange } from "#blocks/delivery/delivery";
import { acquireLinearTicket, workItemFromHandoff } from "#blocks/tickets/linear";
import { provisionWorktree, release, resolveMergePolicy, reviewTicket } from "#jigs";

// This factory's model per harness. A model input left unset takes the default
// of the harness that was actually chosen, so naming one never drags the
// other's default along. Pass `effort` beside `model` to tune a particular
// harness; omit it to keep that provider's default.
const defaultModels = { claude: "opus", codex: "gpt-5.6-sol" };

export const shipInputs = z.object({
  ticket: z.string().min(1),
  binding: z.string(),
  implementationHarness: z.enum(["claude", "codex"]).default("codex"),
  implementationModel: z.string().min(1).optional(),
  reviewHarness: z.enum(["claude", "codex"]).default("claude"),
  reviewModel: z.string().min(1).optional(),
  implementationReviewRounds: z.number().int().positive().default(3),
  ciFixAttempts: z.number().int().nonnegative().default(3),
  pullRequestRevisionRounds: z.number().int().nonnegative().default(3),
});

type ShipInputs = WorkflowInputs<typeof shipInputs>;

/** Take a Linear ticket through implementation, review, and pull-request merge. */
export async function shipWorkflow(inputs: ShipInputs) {
  "use workflow";

  const { claim, snapshot } = await acquireLinearTicket(inputs.ticket);
  const worktree = await provisionWorktree({
    binding: inputs.binding,
    branch: snapshot.branchName,
  });
  const handoff = await reviewTicket({
    claim,
    snapshot,
    harness: claude({ model: defaultModels.claude }),
    cwd: worktree.path,
  });
  const result = await deliverChange({
    task: workItemFromHandoff(handoff),
    worktree,
    binding: inputs.binding,
    implementation: {
      harness: selectHarness(
        inputs.implementationHarness,
        defaultModels,
        inputs.implementationModel,
      ),
    },
    review: { harness: selectHarness(inputs.reviewHarness, defaultModels, inputs.reviewModel) },
    limits: {
      implementationReviewRounds: inputs.implementationReviewRounds,
      ciFixAttempts: inputs.ciFixAttempts,
      pullRequestRevisionRounds: inputs.pullRequestRevisionRounds,
    },
    merge: await resolveMergePolicy(inputs.binding),
  });

  await release();
  return result;
}

export default {
  workflow: shipWorkflow,
  inputs: shipInputs,
  requires: { harnesses: ["claude", "codex"], integrations: ["linear", "github"] },
} satisfies WorkflowEntry<typeof shipInputs>;
