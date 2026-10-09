/**
 * Low-level Linear operations for factory-owned steps. `#jigs/steps` wraps the ones
 * jigs routines and recipes use, such as `postTicketNote`; call the rest, such as
 * `createComment`, from your own `"use step"` function. Higher-level waiting such as
 * `haltForHuman` comes from `#jigs/routines`.
 *
 * See [Waiting and external events](https://salimhamed.github.io/jigs/guide/waiting-and-events).
 *
 * @module steps/linear
 * @packageDocumentation
 */

export {
  type LinearAgentActivityContent,
  type LinearAgentPrompt,
  listLinearAgentSessionPrompts,
  openLinearAgentSession,
  postLinearAgentActivity,
  setLinearAgentSessionUrls,
} from "./agent-sessions.ts";
export { executeLinearAgentTurn, type LinearAgentTurnRequest } from "./agent-turn.ts";
export { fetchTicketSnapshot } from "./fetch-snapshot.ts";
export {
  type CreateIssueInProjectInput,
  createComment,
  createIssueInProject,
  findIssueInProject,
  type LinearIssueMatch,
} from "./issues.ts";
export {
  type HumanInputContext,
  type RenderHumanInputRequest,
  type RenderTicketNote,
  renderHumanInputRequest,
  renderTicketNote,
  type TicketParticipants,
} from "./render.ts";
export { resolveLinearIssue } from "./resolve.ts";
export { setTicketStatus, type TicketStatusResult } from "./status.ts";
export { postTicketHumanInputRequest, postTicketNote } from "./ticket-session.ts";
