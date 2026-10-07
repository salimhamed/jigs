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
  postLinearAgentActivity,
  setLinearAgentSessionUrls,
} from "./agent-sessions.ts";
export { fetchTicketSnapshot } from "./fetch-snapshot.ts";
export {
  type CreateIssueInProjectInput,
  createComment,
  createIssueInProject,
  findIssueInProject,
  type LinearIssueMatch,
} from "./issues.ts";
export {
  checkForTicketHumanReply,
  postTicketHumanInputRequest,
  postTicketNote,
} from "./needs-human-comments.ts";
export {
  type NeedsHumanContext,
  type RenderNeedsHumanComment,
  type RenderTicketNote,
  renderNeedsHumanComment,
  renderTicketNote,
  type TicketParticipants,
} from "./render-comment.ts";
export { resolveLinearIssue } from "./resolve.ts";
export { setTicketStatus, type TicketStatusResult } from "./status.ts";
