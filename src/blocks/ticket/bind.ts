import { agentOrHalt as agentOrHaltBlock } from "../agent/agent-or-halt.ts";
import type { AgentStepConfig } from "../agent/plan.ts";
import type { TicketClaim } from "./claim.ts";
import {
  type CheckForReply,
  type HaltForHumanFn,
  haltForHuman as haltBlock,
  type PostComment,
} from "./halt-for-human.ts";
import { type ReviewTicketOptions, reviewTicket as reviewBlock } from "./review.ts";
export type BoundReviewTicketOptions = Omit<
  ReviewTicketOptions,
  "runAgent" | "haltForHuman" | "fetchTicketSnapshot" | "postNote"
>;

export interface LinearSteps {
  runAgent: ReviewTicketOptions["runAgent"];
  postComment: PostComment;
  postNote: ReviewTicketOptions["postNote"];
  checkForReply: CheckForReply;
  fetchTicketSnapshot: ReviewTicketOptions["fetchTicketSnapshot"];
}

/** Connect Linear clarification and review to the factory's durable steps. */
export function bindLinearSteps(steps: LinearSteps) {
  const { runAgent } = steps;
  const haltForHuman: HaltForHumanFn = (claim, halt) =>
    haltBlock(claim, halt, {
      postComment: steps.postComment,
      checkForReply: steps.checkForReply,
    });
  function agentOrHalt<T = undefined>(claim: TicketClaim, config: AgentStepConfig<T>) {
    return agentOrHaltBlock(claim, config, { runAgent, haltForHuman });
  }
  function reviewTicket(options: BoundReviewTicketOptions) {
    return reviewBlock({
      ...options,
      runAgent,
      haltForHuman,
      postNote: steps.postNote,
      fetchTicketSnapshot: steps.fetchTicketSnapshot,
    });
  }
  return { haltForHuman, agentOrHalt, reviewTicket };
}
