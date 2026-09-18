import { runAgentOrHalt as agentOrHaltBlock } from "../agents/agent-or-halt.ts";
import type { RunAgentOptions } from "../agents/plan.ts";
import type { TicketClaim } from "./claim.ts";
import {
  type CheckForTicketHumanReply,
  type HaltForHumanFn,
  haltForHuman as haltBlock,
  type PostTicketHumanInputRequest,
} from "./halt-for-human.ts";
import { type ReviewTicketOptions, reviewTicket as reviewBlock } from "./review.ts";
export type BoundReviewTicketOptions = Omit<
  ReviewTicketOptions,
  "runAgent" | "haltForHuman" | "fetchTicketSnapshot" | "postTicketNote"
>;

export interface LinearSteps {
  runAgent: ReviewTicketOptions["runAgent"];
  postTicketHumanInputRequest: PostTicketHumanInputRequest;
  postTicketNote: ReviewTicketOptions["postTicketNote"];
  checkForTicketHumanReply: CheckForTicketHumanReply;
  fetchTicketSnapshot: ReviewTicketOptions["fetchTicketSnapshot"];
}

/** Connect Linear clarification and review to the factory's durable steps. */
export function bindLinearSteps(steps: LinearSteps) {
  const { runAgent } = steps;
  const haltForHuman: HaltForHumanFn = (claim, halt) =>
    haltBlock(claim, halt, {
      postTicketHumanInputRequest: steps.postTicketHumanInputRequest,
      checkForTicketHumanReply: steps.checkForTicketHumanReply,
    });
  function runAgentOrHalt<T = undefined>(claim: TicketClaim, config: RunAgentOptions<T>) {
    return agentOrHaltBlock(claim, config, { runAgent, haltForHuman });
  }
  function reviewTicket(options: BoundReviewTicketOptions) {
    return reviewBlock({
      ...options,
      runAgent,
      haltForHuman,
      postTicketNote: steps.postTicketNote,
      fetchTicketSnapshot: steps.fetchTicketSnapshot,
    });
  }
  return { haltForHuman, runAgentOrHalt, reviewTicket };
}
