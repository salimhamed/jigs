import { agentOrHalt as agentOrHaltBlock } from "../agent/agent-or-halt.ts";
import type { AgentStepConfig } from "../agent/plan.ts";
import type { TicketClaim } from "./claim.ts";
import {
  type CheckForHumanReply,
  type HaltForHumanFn,
  haltForHuman as haltBlock,
  type PostNeedsHumanComment,
} from "./halt-for-human.ts";
import { type ReviewTicketOptions, reviewTicket as reviewBlock } from "./review.ts";
export type BoundReviewTicketOptions = Omit<
  ReviewTicketOptions,
  "agent" | "haltForHuman" | "fetchTicketSnapshot" | "postNote"
>;

export interface LinearSteps {
  agent: ReviewTicketOptions["agent"];
  postNeedsHumanComment: PostNeedsHumanComment;
  postTicketNote: ReviewTicketOptions["postNote"];
  checkForHumanReply: CheckForHumanReply;
  fetchTicketSnapshot: ReviewTicketOptions["fetchTicketSnapshot"];
}

/** Connect Linear clarification and review to the factory's durable steps. */
export function bindLinearSteps(steps: LinearSteps) {
  const { agent } = steps;
  const haltForHuman: HaltForHumanFn = (claim, halt) =>
    haltBlock(claim, halt, {
      postComment: steps.postNeedsHumanComment,
      checkForReply: steps.checkForHumanReply,
    });
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
  return { haltForHuman, agentOrHalt, reviewTicket };
}
