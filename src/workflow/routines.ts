/**
 * The library routines your factory's generated `jigs/routines.ts` binds to its steps.
 *
 * Import routines from `#jigs/routines` in workflow code, never from here: the generated file is
 * the only caller this entry has.
 *
 * @module routines
 * @packageDocumentation
 */

export {
  type AgentSession,
  type AgentSessionOptions,
  type AgentSessionTurn,
  bindAgentSession,
  type RunAgentFn,
} from "./agents/agent-session.ts";
export { type AgentSteps, bindAgentSteps } from "./agents/bind.ts";
export { bindDeliverySteps } from "./delivery/bind.ts";
export type { DeliverySteps } from "./delivery/delivery.ts";
export {
  type BranchState,
  bindGitSteps,
  type CommittedWorkOptions,
  type GitSteps,
  type ReadBranchState,
} from "./git/committed-work.ts";
export { bindLinearSteps, type LinearSteps } from "./linear/bind.ts";
export { claimTicket } from "./linear/claim.ts";
export { type AcquireTicketSteps, acquireTicket } from "./linear/prelude.ts";
export { type PostPullRequestNoteOptions, postPullRequestNote } from "./pull-requests/answers.ts";
export { bindPullRequestSteps, type PullRequestSteps } from "./pull-requests/bind.ts";
export { type SlackReplySteps, waitForSlackReply } from "./slack/wait-for-reply.ts";
