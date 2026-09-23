import { runAgentOrHalt as agentOrHaltBlock } from "../agents/agent-or-halt.ts";
import type { RunAgentOptions } from "../agents/plan.ts";
import type { TicketClaim } from "./claim.ts";
import {
  type CheckForTicketHumanReply,
  type HaltForHumanFn,
  haltForHuman as haltBlock,
  type PostTicketHumanInputRequest,
} from "./halt-for-human.ts";
import {
  noteOnTicket as noteBlock,
  type ReviewTicketOptions,
  reviewTicket as reviewBlock,
  type TicketNote,
} from "./review.ts";

/** Ticket-review options left after the factory's durable steps are bound. */
export type BoundReviewTicketOptions = Omit<
  ReviewTicketOptions,
  "runAgent" | "haltForHuman" | "fetchTicketSnapshot" | "postTicketNote"
>;

/**
 * Durable wrappers a factory supplies for Linear and agent operations.
 *
 * @group Factory plumbing
 */
export interface LinearSteps {
  runAgent: ReviewTicketOptions["runAgent"];
  postTicketHumanInputRequest: PostTicketHumanInputRequest;
  postTicketNote: ReviewTicketOptions["postTicketNote"];
  checkForTicketHumanReply: CheckForTicketHumanReply;
  fetchTicketSnapshot: ReviewTicketOptions["fetchTicketSnapshot"];
}

/**
 * Connect Linear clarification and review to the factory's durable steps.
 *
 * @group Factory plumbing
 */
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
  function noteOnTicket(claim: TicketClaim, note: TicketNote) {
    return noteBlock(claim, note, { postTicketNote: steps.postTicketNote });
  }
  return { haltForHuman, runAgentOrHalt, reviewTicket, noteOnTicket };
}
