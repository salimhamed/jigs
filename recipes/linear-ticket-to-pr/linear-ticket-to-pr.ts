import {
  defineWorkflow,
  harnesses,
  JigsError,
  jevModel,
  renderTicketSnapshot,
  type TicketHandoff,
  type WorkflowInputs,
  type Worktree,
} from "@jigs-ai/jigs";
import { z } from "zod";
import { acquireTicket, agentSession, decide, noteOnTicket, reviewTicket } from "#jigs/routines";
import { provisionWorktree, setTicketStatus } from "#jigs/steps";
import {
  type FailureState,
  failureTriage,
  SMALL,
  type TicketSizeState,
  ticketSize,
} from "./decisions.ts";
import { CUTOFF } from "./delivery/decisions.ts";
import {
  type Budget,
  DeliveryStopped,
  followPullRequest,
  implementAndReview,
  publish,
  type WorkItem,
} from "./delivery/delivery.ts";

// The agents this workflow can run, by the part they play. A run picks one per
// part by name; edit a line here to change a default model or harness. Tickets
// Jev sizes as trivial or small get the light pair unless the run names one.
const agents = {
  builder: harnesses.codex({ model: "gpt-5.6-sol" }),
  reviewer: harnesses.claude({ model: "opus" }),
  builderLight: harnesses.claude({ model: "sonnet" }),
  reviewerLight: harnesses.claude({ model: "sonnet" }),
};
const agentName = z.enum(["builder", "reviewer", "builderLight", "reviewerLight"]);

// Budgets by ticket size, trivial to large, when the run does not set them.
const budgetBySize: Budget[] = [
  { reviewRounds: 1, attemptsPerUpdate: 1 },
  { reviewRounds: 2, attemptsPerUpdate: 2 },
  { reviewRounds: 3, attemptsPerUpdate: 3 },
  { reviewRounds: 3, attemptsPerUpdate: 3 },
];
const defaultBudget: Budget = { reviewRounds: 3, attemptsPerUpdate: 3 };

// Who merges a pull request once it is approved and CI is green:
// "jigs" merges it, "human" leaves the merge to you.
const mergedBy: "jigs" | "human" = "human";

const inputs = z.object({
  ticket: z.string().min(1),
  binding: z.string(),
  builder: agentName.optional(),
  reviewer: agentName.optional(),
  // Fixed for the life of the run. To spend more, start another run.
  budget: z
    .object({
      reviewRounds: z.number().int().positive().optional(),
      attemptsPerUpdate: z.number().int().positive().optional(),
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

  const size = await decide({
    site: "ticket-size",
    state: {
      ticket: renderTicketSnapshot(handoff.snapshot),
      brief: handoff.brief,
    } satisfies TicketSizeState,
    question: ticketSize,
    cutoff: CUTOFF,
  });
  const sized = size.confident ? Math.round(size.answer.score) : undefined;
  const light = sized !== undefined && sized <= SMALL;
  const budget = (sized === undefined ? undefined : budgetBySize[sized]) ?? defaultBudget;

  const delivery = {
    task: workItem(handoff),
    worktree,
    builder: agents[input.builder ?? (light ? "builderLight" : "builder")],
    reviewer: agents[input.reviewer ?? (light ? "reviewerLight" : "reviewer")],
    budget: {
      reviewRounds: input.budget.reviewRounds ?? budget.reviewRounds,
      attemptsPerUpdate: input.budget.attemptsPerUpdate ?? budget.attemptsPerUpdate,
    },
    mergedBy,
  };

  const builder = agentSession({ name: "builder", harness: delivery.builder, cwd: worktree.path });
  const phase = <T>(name: string, run: () => Promise<T>) =>
    withFailureTriage(name, snapshot.identifier, worktree, run);

  try {
    const approved = await phase("implement and review", () =>
      implementAndReview(delivery, builder),
    );
    const pr = await phase("publish", () => publish(delivery, approved));
    await setTicketStatus(snapshot.id, "In Review");
    await phase("follow the pull request", () => followPullRequest(delivery, pr, builder));
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

/**
 * Run a phase; when it fails with anything but DeliveryStopped, ask Jev what kind of failure it
 * is. A transient failure retries the phase once, and one a person must fix becomes a
 * DeliveryStopped so the ticket gets a note. Anything else, or an unsure answer, is rethrown.
 */
async function withFailureTriage<T>(
  phase: string,
  key: string,
  worktree: Worktree,
  run: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (error instanceof DeliveryStopped || !(error instanceof Error)) throw error;
      const hint = error instanceof JigsError ? (error.hint ?? null) : null;
      const failure = await decide({
        site: "failure-triage",
        state: {
          phase,
          attempt,
          name: error.name,
          message: error.message,
          hint,
        } satisfies FailureState,
        question: failureTriage,
        cutoff: CUTOFF,
      });
      if (!failure.confident) throw error;
      if (failure.answer.choice === "transient" && attempt === 1) continue;
      if (failure.answer.choice === "needs-human")
        throw new DeliveryStopped(
          `jigs stopped work on ${key} while trying to ${phase}: something outside the code needs fixing first.`,
          [hint === null ? error.message : `${error.message}; ${hint}`],
          worktree,
          "Fix the cause above, then start another run.",
        );
      throw error;
    }
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
  requires: { agents, models: [jevModel], integrations: ["linear", "github"] },
  workflow: linearTicketToPr,
});
