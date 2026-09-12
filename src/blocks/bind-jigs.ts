import { agent as agentBlock, type RunAgentStep } from "./agent/agent.ts";
import { agentOrHalt as agentOrHaltBlock } from "./agent/agent-or-halt.ts";
import { ask as askBlock, type RunAskStep } from "./agent/ask.ts";
import type { AgentStepConfig, AskStepConfig } from "./agent/plan.ts";
import {
  type FetchPrState,
  type GateFn,
  pullRequestGate as gateBlock,
} from "./pull-request/gate.ts";
import type { TicketClaim } from "./ticket/claim.ts";
import {
  type CheckForHumanReply,
  type HaltForHumanFn,
  haltForHuman as haltBlock,
  type PostNeedsHumanComment,
} from "./ticket/halt-for-human.ts";
import { type ReviewTicketOptions, reviewTicket as reviewBlock } from "./ticket/review.ts";

/** Named factory steps used by the standard jigs blocks. Replace any member
 * with a custom factory step to customize behavior without editing jigs.ts. */
export interface JigsSteps {
  runAgent: RunAgentStep;
  askModel: RunAskStep;
  postNeedsHumanComment: PostNeedsHumanComment;
  postTicketNote: ReviewTicketOptions["postNote"];
  checkForHumanReply: CheckForHumanReply;
  fetchPullRequestState: FetchPrState;
  fetchTicketSnapshot: ReviewTicketOptions["fetchTicketSnapshot"];
}

export type BoundReviewTicketOptions = Omit<
  ReviewTicketOptions,
  "agent" | "haltForHuman" | "fetchTicketSnapshot" | "postNote"
>;

/** Bind reusable workflow blocks to the factory's durable step functions. */
export function bindJigs(steps: JigsSteps) {
  function agent<T = undefined>(config: AgentStepConfig<T>) {
    return agentBlock(config, steps.runAgent);
  }
  function ask<T = undefined>(config: AskStepConfig<T>) {
    return askBlock(config, steps.askModel);
  }
  const haltForHuman: HaltForHumanFn = (claim, halt) =>
    haltBlock(claim, halt, {
      postComment: steps.postNeedsHumanComment,
      checkForReply: steps.checkForHumanReply,
    });
  const pullRequestGate: GateFn = (pr) => gateBlock(pr, steps.fetchPullRequestState);
  function agentOrHalt<T = undefined>(claim: TicketClaim, config: AgentStepConfig<T>) {
    return agentOrHaltBlock(claim, config, { agent, haltForHuman });
  }
  function reviewTicket(options: BoundReviewTicketOptions) {
    return reviewBlock({
      ...options,
      agent,
      haltForHuman,
      postNote: steps.postTicketNote,
      fetchTicketSnapshot: steps.fetchTicketSnapshot,
    });
  }
  return {
    /** Run an agent in a worktree and validate its answer. */
    agent,
    /** Ask a model a question without a worktree or tools, and validate its answer. */
    ask,
    /** Pause the run until someone replies on the ticket. */
    haltForHuman,
    /** Wait until the pull request needs action or is ready to merge. */
    pullRequestGate,
    /** Run an agent, pausing for help when a required capability is unavailable. */
    agentOrHalt,
    /** Review the ticket and clarify missing details before building. */
    reviewTicket,
  };
}
