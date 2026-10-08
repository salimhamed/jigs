/**
 * Workflow operations bound to your factory's durable step wrappers, imported from
 * `#jigs/routines`. Routines compose recorded steps and waits; they have no recorded result of
 * their own.
 *
 * @module factory/routines
 * @packageDocumentation
 */
// Copied into the factory's .jigs/ by `jigs build`. Do not edit the copy.

import type {
  LinearAgentConversationOptions,
  LinearAgentSessionInputs,
  SlackQuestion,
} from "@jigs-ai/jigs";
import {
  acquireTicket as acquireTicketRoutine,
  bindAgentSession,
  bindAgentSteps,
  bindDeliverySteps,
  bindGitSteps,
  bindLinearSteps,
  bindPullRequestSteps,
  linearAgentConversation as linearAgentConversationRoutine,
  waitForSlackReply as waitForSlackReplyRoutine,
} from "@jigs-ai/jigs/routines";
import {
  commentOnPullRequest,
  createPullRequest,
  executeAgent,
  executeJev,
  executeLinearAgentTurn,
  executeModel,
  fetchPullRequestState,
  fetchSlackMessage,
  fetchTicketSnapshot,
  listLinearAgentSessionPrompts,
  mergePullRequest,
  openLinearAgentSession,
  postLinearAgentActivity,
  postTicketHumanInputRequest,
  postTicketNote,
  pushApprovedChange,
  readBranchState,
  readWorktreeDiff,
  registerResource,
  resolveLinearIssue,
  setLinearAgentSessionUrls,
} from "./steps.ts";

const agents = bindAgentSteps({ executeAgent, executeJev, executeModel });

/**
 * Run an agent with tools and validate its answer against your output schema.
 *
 * @group Agents and models
 */
export const runAgent = agents.runAgent;

/**
 * One agent across several turns: resumes the session it holds, or starts fresh when it cannot.
 *
 * @group Agents and models
 *
 * @remarks
 * Each turn supplies an incremental `resume` prompt and a complete `fresh` prompt.
 * A prompt may be a function, evaluated only when selected. A missing session or
 * changed harness descriptor starts fresh. The helper is rebuilt on replay;
 * recorded `AgentSessionRef` data restores the session reference.
 *
 * @inlineType AgentSessionOptions
 */
export const agentSession = bindAgentSession(runAgent);

/**
 * Ask an agent harness without tools or a worktree.
 *
 * @group Agents and models
 */
export const askAgent = agents.askAgent;

/**
 * Ask a model without tools and validate its answer against your output schema.
 *
 * @group Agents and models
 */
export const askModel = agents.askModel;

/**
 * Ask a decision model named questions and receive calibrated typed answers.
 *
 * @group Agents and models
 */
export const askJev = agents.askJev;

const linear = bindLinearSteps({
  postTicketHumanInputRequest,
  postTicketNote,
  listLinearAgentSessionPrompts,
  postLinearAgentActivity,
});

/**
 * Ask in the ticket's Linear agent session and wait for a reply there.
 *
 * @group Linear and human input
 *
 * @remarks
 * Posts the question in the session the claim holds, then waits until someone
 * answers in it. Messages sent there since the run last read it answer at once.
 * The question mentions the operator (or the ticket's creator) and the assignee;
 * list more emails in the halt's `mention`.
 *
 * @inlineType HaltForHumanFn
 */
export const haltForHuman = linear.haltForHuman;

/**
 * Post a note in the ticket's Linear agent session that asks for nothing and waits for nothing.
 * Set `run: "ended"` on the run's last note, success or not, to end the session. Set
 * `run: "waiting"` before a long wait on people, so the session shows awaiting input and never
 * goes stale.
 *
 * @group Linear and human input
 */
export const noteOnTicket = linear.noteOnTicket;

/**
 * Resolve a Linear ticket in the named Linear installation, claim it, and read its requirements,
 * before any protected work. The run opens a Linear agent session on the ticket, or takes the
 * `session` that started it, and talks to people only there.
 *
 * @group Linear and human input
 */
export const acquireTicket = (ticket: {
  installationName: string;
  reference: string;
  session?: string;
}) =>
  acquireTicketRoutine(ticket, {
    resolveLinearIssue,
    fetchTicketSnapshot,
    openLinearAgentSession,
    postLinearAgentActivity,
    setLinearAgentSessionUrls,
  });

export const {
  /**
   * Read branch state, failing unless there is a new commit and no uncommitted work.
   *
   * @remarks
   * Counts commits since the worktree base, or `options.since` when supplied.
   * Returns the head SHA, commit count and clean state; fails with a repair hint
   * if the agent left no new commit or uncommitted changes.
   *
   * @group Git changes
   * @inlineType CommittedWorkOptions
   * @inlineType BranchState
   */
  committedWork,
} = bindGitSteps({ readBranchState });

const pullRequests = bindPullRequestSteps({ fetchPullRequestState, commentOnPullRequest });

/**
 * Read current pull request facts, then yield changed snapshots until it closes.
 *
 * @group Pull requests
 *
 * @remarks
 * Reads once immediately, then rereads on each GitHub event from the hub and on `jigs poke`.
 * Duplicate wakes and reordered collections with unchanged facts do not yield again.
 * Snapshots include comments regardless of author or jigs markers; the workflow
 * owns decisions, action limits and merging. A closed snapshot is yielded once.
 * Leaving the loop releases the watch. Only one run may watch a pull request;
 * a second owner receives `ClaimConflictError`.
 */
export const watchPullRequest = pullRequests.watchPullRequest;

/**
 * Post a note about a commit, once per head and reason.
 *
 * @group Pull requests
 *
 * @remarks
 * Reads current comments and skips a note already marked with this scope, head and reason.
 * Use `ci` for a CI update, `merge` for a merge refusal, or `merge-retry` for a temporary
 * refusal. The reason does not change readiness or schedule more work. Posting failures
 * are logged and return without throwing; the workflow decides whether to try again.
 */
export const postPullRequestNote = pullRequests.postPullRequestNote;

const delivery = bindDeliverySteps({
  readBranchState,
  readWorktreeDiff,
  pushApprovedChange,
  createPullRequest,
  registerResource,
  fetchPullRequestState,
  mergePullRequest,
});

/**
 * Build and review a delivery's change until the reviewer raises no blocking finding.
 * Ends `approved` with the reviewed commit, or `stopped` when the rounds run out or there is
 * nothing to review.
 *
 * @group Pull request delivery
 */
export const buildAndReview = delivery.buildAndReview;

/**
 * Have the writer, or the builder, write the pull request's title and body from the diff.
 * An optional `check` returns problems; the writer is sent back once with them.
 *
 * @group Pull request delivery
 */
export const describePullRequest = delivery.describePullRequest;

/**
 * Push exactly the given commit and open its pull request with the given title and body.
 *
 * @group Pull request delivery
 */
export const publishPullRequest = delivery.publishPullRequest;

/**
 * Follow a delivery's pull request until it merges or closes, waking the builder for feedback.
 * Ends `merged` or `closed`.
 *
 * @group Pull request delivery
 *
 * @remarks
 * `wake` decides what wakes the builder; pass `builderWakeFacts` for the default rules. A pull
 * request that needs a person, a blocked merge included, reaches the workflow through
 * `onNeedsHuman` with facts; the workflow words and sends any note. When `mergeWhen` agrees, an
 * approved, green, clean pull request merges once local work is published.
 */
export const followPullRequestToOutcome = delivery.followPullRequestToOutcome;

/**
 * Wait for a human reply in a Slack thread after `lastRead`. Ends `replied` with every such
 * reply, never empty and oldest first, `timed-out` after `until`, or `gone` if deleted.
 *
 * @remarks
 * Binds the library's `waitForSlackReply` routine to this factory's `fetchSlackMessage`
 * step; its documentation covers deadlines, wakes, deletion and conflicts.
 *
 * @group Slack messages
 */
export const waitForSlackReply = (question: SlackQuestion) =>
  waitForSlackReplyRoutine(question, { fetchSlackMessage });

/**
 * Hold a conversation with Claude in the Linear agent session that started this run, until no
 * one replies for `idleFor` (four hours by default), someone presses stop, or a turn fails.
 *
 * @remarks
 * Binds the library's `linearAgentConversation` routine to this factory's steps; its
 * documentation covers turns, stops and what Linear shows.
 *
 * @group Linear agent sessions
 */
export const linearAgentConversation = (
  session: LinearAgentSessionInputs,
  options: LinearAgentConversationOptions,
) =>
  linearAgentConversationRoutine(session, options, {
    executeLinearAgentTurn,
    listLinearAgentSessionPrompts,
    postLinearAgentActivity,
    setLinearAgentSessionUrls,
  });

// Routines bound to no step, and the types a workflow names.
export type { AgentSession, AgentSessionTurn } from "@jigs-ai/jigs/routines";
