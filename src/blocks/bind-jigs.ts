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
import {
  type ReviewTicketOptions,
  reviewTicket as reviewBlock,
} from "./ticket/review.ts";

/** Named factory steps used by the standard jigs blocks. Replace any member
 * with a custom factory step to customize behavior without editing jigs.ts. */
export interface JigsSteps {
  runAgent: RunAgentStep;
  askModel: RunAskStep;
  postNeedsHumanComment: PostNeedsHumanComment;
  postTicketNote: ReviewTicketOptions["postNote"];
  checkForHumanReply: CheckForHumanReply;
  fetchPullRequestState: FetchPrState;
  fetchTicketSnapshot: ReviewTicketOptions["fetchSnapshot"];
}

export type BoundReviewTicketOptions = Omit<
  ReviewTicketOptions,
  "agent" | "haltForHuman" | "fetchSnapshot" | "postNote"
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
  const pullRequestGate: GateFn = (pr) =>
    gateBlock(pr, steps.fetchPullRequestState);
  function agentOrHalt<T = undefined>(
    claim: TicketClaim,
    config: AgentStepConfig<T>,
  ) {
    return agentOrHaltBlock(claim, config, { agent, haltForHuman });
  }
  function reviewTicket(options: BoundReviewTicketOptions) {
    return reviewBlock({
      ...options,
      agent,
      haltForHuman,
      postNote: steps.postTicketNote,
      fetchSnapshot: steps.fetchTicketSnapshot,
    });
  }
  return {
    agent,
    ask,
    haltForHuman,
    pullRequestGate,
    agentOrHalt,
    reviewTicket,
  };
}
