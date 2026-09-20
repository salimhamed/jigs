/**
 * Read and update Linear issues outside workflow code.
 *
 * Wrap steps in a factory-owned `"use step"` file. Never call them directly from a workflow.
 *
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
