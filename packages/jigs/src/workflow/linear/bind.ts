import type { TicketClaim } from "./claim.ts";
import {
  type CheckForTicketHumanReply,
  type HaltForHumanFn,
  haltForHuman as haltRoutine,
  type PostTicketHumanInputRequest,
} from "./halt-for-human.ts";
import { noteOnTicket as noteRoutine, type PostTicketNote, type TicketNote } from "./review.ts";

/**
 * Durable wrappers a factory supplies for Linear operations.
 *
 * @group Factory plumbing
 */
export interface LinearSteps {
  postTicketHumanInputRequest: PostTicketHumanInputRequest;
  postTicketNote: PostTicketNote;
  checkForTicketHumanReply: CheckForTicketHumanReply;
}

/**
 * Connect Linear clarification and notes to the factory's durable steps.
 *
 * @group Factory plumbing
 */
export function bindLinearSteps(steps: LinearSteps) {
  const haltForHuman: HaltForHumanFn = (claim, halt) =>
    haltRoutine(claim, halt, {
      postTicketHumanInputRequest: steps.postTicketHumanInputRequest,
      checkForTicketHumanReply: steps.checkForTicketHumanReply,
    });
  function noteOnTicket(claim: TicketClaim, note: TicketNote) {
    return noteRoutine(claim, note, { postTicketNote: steps.postTicketNote });
  }
  return { haltForHuman, noteOnTicket };
}
