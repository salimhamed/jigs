/**
 * Low-level Linear operations for factory-owned steps. Workflow code calls their
 * `#jigs/steps` wrappers; higher-level waiting such as `haltForHuman` comes from
 * `#jigs/routines`.
 *
 * See [Waiting and external events](https://salimhamed.github.io/jigs/guide/waiting-and-events).
 *
 * @module steps/linear
 * @packageDocumentation
 */

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
