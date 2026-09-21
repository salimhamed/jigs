import type { WorkflowEntry, WorkflowInputs } from "@salimhamed/jigs";
import { type HarnessKind, harnesses } from "@salimhamed/jigs/blocks/agents";
import { z } from "zod";
import { deliverChange } from "#blocks/delivery/delivery";
import { acquireLinearTicket, workItemFromHandoff } from "#blocks/tickets/linear";
import {
  postTicketNote,
  provisionWorktree,
  release,
  resolveMergePolicy,
  reviewTicket,
  setTicketStatus,
} from "#jigs";

// This factory's model per harness. A model input left unset takes the default
// of the harness that was actually chosen, so naming one never drags the
// other's default along. Pass `effort` beside `model` to tune a particular
// harness; omit it to keep that provider's default.
const defaultModels = { claude: "opus", codex: "gpt-5.6-sol" };

function harness(kind: Extract<HarnessKind, "claude" | "codex">, model?: string) {
  const selected = model ?? defaultModels[kind];
  return kind === "claude" ? harnesses.claude(selected) : harnesses.codex(selected);
}

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
  await setTicketStatus(snapshot.id, "In Progress");
  const worktree = await provisionWorktree({
    binding: inputs.binding,
    branch: snapshot.branchName,
  });
  const handoff = await reviewTicket({
    claim,
    snapshot,
    harness: harnesses.claude(defaultModels.claude),
    cwd: worktree.path,
  });
  const result = await deliverChange({
    task: workItemFromHandoff(handoff),
    worktree,
    binding: inputs.binding,
    implementation: {
      harness: harness(inputs.implementationHarness, inputs.implementationModel),
    },
    review: { harness: harness(inputs.reviewHarness, inputs.reviewModel) },
    limits: {
      implementationReviewRounds: inputs.implementationReviewRounds,
      ciFixAttempts: inputs.ciFixAttempts,
      pullRequestRevisionRounds: inputs.pullRequestRevisionRounds,
    },
    merge: await resolveMergePolicy(inputs.binding),
    on: {
      pullRequestOpened: async () => {
        await setTicketStatus(snapshot.id, "In Review");
      },
      merged: async (pr) => {
        await setTicketStatus(snapshot.id, "Done");
        await postTicketNote(snapshot.id, {
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

export default {
  workflow: shipWorkflow,
  inputs: shipInputs,
  requires: { harnesses: ["claude", "codex"], integrations: ["linear", "github"] },
} satisfies WorkflowEntry<typeof shipInputs>;
