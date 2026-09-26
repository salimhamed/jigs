import {
  runAgentOrHalt as agentOrHaltRoutine,
  type RunAgentOrHaltOptions,
} from "../agents/agent-or-halt.ts";
import type { ExecuteJevStep } from "../agents/jev.ts";
import type { RunAgentOptions } from "../agents/plan.ts";
import type { TicketClaim } from "./claim.ts";
import {
  type CheckForTicketHumanReply,
  type HaltForHumanFn,
  haltForHuman as haltRoutine,
  type PostTicketHumanInputRequest,
} from "./halt-for-human.ts";
import {
  noteOnTicket as noteRoutine,
  type ReviewTicketOptions,
  reviewTicket as reviewRoutine,
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
  executeJev: ExecuteJevStep;
}

/**
 * Connect Linear clarification and review to the factory's durable steps.
 *
 * @group Factory plumbing
 */
export function bindLinearSteps(steps: LinearSteps) {
  const { runAgent } = steps;
  const haltForHuman: HaltForHumanFn = (claim, halt) =>
    haltRoutine(claim, halt, {
      postTicketHumanInputRequest: steps.postTicketHumanInputRequest,
      checkForTicketHumanReply: steps.checkForTicketHumanReply,
      executeJev: steps.executeJev,
    });
  function runAgentOrHalt<T = undefined>(
    claim: TicketClaim,
    config: RunAgentOptions<T>,
    options?: RunAgentOrHaltOptions,
  ) {
    return agentOrHaltRoutine(claim, config, { runAgent, haltForHuman }, options);
  }
  function reviewTicket(options: BoundReviewTicketOptions) {
    return reviewRoutine({
      ...options,
      runAgent,
      haltForHuman,
      postTicketNote: steps.postTicketNote,
      fetchTicketSnapshot: steps.fetchTicketSnapshot,
    });
  }
  function noteOnTicket(claim: TicketClaim, note: TicketNote) {
    return noteRoutine(claim, note, { postTicketNote: steps.postTicketNote });
  }
  return { haltForHuman, runAgentOrHalt, reviewTicket, noteOnTicket };
}
