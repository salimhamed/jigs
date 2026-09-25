import {
  defineWorkflow,
  harnesses,
  renderTicketSnapshot,
  type TicketHandoff,
  type WorkflowInputs,
} from "@jigs-ai/jigs";
import { z } from "zod";
import { acquireTicket, agentSession, noteOnTicket, reviewTicket } from "#jigs/routines";
import { provisionWorktree, setTicketStatus } from "#jigs/steps";
import {
  DeliveryStopped,
  followPullRequest,
  implementAndReview,
  publish,
  type WorkItem,
} from "./delivery/delivery.ts";

// The agents this workflow can run, by the part they play. A run picks one per
// part by name; edit a line here to change a default model or harness.
const agents = {
  builder: harnesses.codex({ model: "gpt-5.6-sol" }),
  reviewer: harnesses.claude({ model: "opus" }),
};
const agentName = z.enum(["builder", "reviewer"]);

const inputs = z.object({
  ticket: z.string().min(1),
  binding: z.string(),
  builder: agentName.default("builder"),
  reviewer: agentName.default("reviewer"),
  // Fixed for the life of the run. To spend more, start another run.
  budget: z
    .object({
      reviewRounds: z.number().int().positive().default(3),
      attemptsPerUpdate: z.number().int().positive().default(3),
    })
    .prefault({}),
});

/** Take a Linear ticket through implementation, review, and pull-request merge. */
export async function linearTicketToPr(input: WorkflowInputs<typeof inputs>) {
  "use workflow";

  const { claim, snapshot } = await acquireTicket(input.ticket);
  await setTicketStatus(snapshot.id, "In Progress");

  const worktree = await provisionWorktree({ binding: input.binding, branch: snapshot.branchName });
  const handoff = await reviewTicket({
    claim,
    snapshot,
    harness: agents.reviewer,
    cwd: worktree.path,
  });

  const delivery = {
    task: workItem(handoff),
    worktree,
    builder: agents[input.builder],
    reviewer: agents[input.reviewer],
    budget: input.budget,
  };

  const builder = agentSession({ name: "builder", harness: delivery.builder, cwd: worktree.path });

  try {
    const approved = await implementAndReview(delivery, builder);
    const pr = await publish(delivery, approved);
    await setTicketStatus(snapshot.id, "In Review");
    await followPullRequest(delivery, pr, builder);
    await setTicketStatus(snapshot.id, "Done");
    return { pr: pr.url };
  } catch (error) {
    if (error instanceof DeliveryStopped) {
      await noteOnTicket(claim, error.note());
      await setTicketStatus(snapshot.id, "Todo");
    }
    throw error;
  }
}

/** The ticket and its implementation brief, as one statement of the work. */
function workItem(handoff: TicketHandoff): WorkItem {
  return {
    id: handoff.snapshot.id,
    key: handoff.snapshot.identifier,
    title: handoff.snapshot.title,
    url: handoff.snapshot.url,
    instructions: `${renderTicketSnapshot(handoff.snapshot)}\n\n## Implementation brief\n${handoff.brief}\n\nThe ticket requirements take precedence over the brief.`,
  };
}

export default defineWorkflow({
  inputs,
  requires: { agents, integrations: ["linear", "github"] },
  workflow: linearTicketToPr,
});
