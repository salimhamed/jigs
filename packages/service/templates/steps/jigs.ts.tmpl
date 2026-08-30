// This factory's half of every jigs step, and the jigs wired on top of them.
//
// LOAD-BEARING NAMES. Each `"use step"` function below compiles to a durable
// id built from this file's path and the function's name —
// `step//./steps/jigs//worktree`. Those ids are the memoization keys of every
// run this factory has parked. Renaming this file, moving it, or renaming an
// exported function silently orphans those runs: the build stays green and
// replay simply looks up ids that no longer exist. Treat them exactly like the
// filenames in pipelines/.
//
// `jigs init` writes this file once and never rewrites it — it is your source
// from here on. When a jigs release adds a step, re-running `jigs init` offers
// to append the wrappers you are missing, and `jigs build` warns when any are.
//
// The implementations are imported at module scope on purpose: the `"use
// step"` transform erases each body below out of the workflow bundle, and the
// imports only those bodies reach go with it, so @jigs/service's node-builtin
// code never crosses into the workflow sandbox.

import {
  type ReviewLoopOptions,
  reviewLoop as reviewLoopJig,
} from "@jigs/service/review-loop/loop";
import {
  commentOnPr as commentOnPrImpl,
  openPr as openPrImpl,
  pushWorktreeBranch as pushWorktreeBranchImpl,
  readDiff as readDiffImpl,
  replyInThread as replyInThreadImpl,
  resolveRepo as resolveRepoImpl,
  squashMerge as squashMergeImpl,
} from "@jigs/service/review-loop/pull-request";
import { agent as agentJig, ask as askJig } from "@jigs/service/steps";
import { agentOrHalt as agentOrHaltJig } from "@jigs/service/steps/jit";
import { runAgent, runAsk } from "@jigs/service/steps/run";
import type { TicketClaim } from "@jigs/service/suspension/claim";
import {
  checkForHumanReply as checkForHumanReplyImpl,
  type NeedsHumanFn,
  needsHuman as needsHumanJig,
  postNeedsHumanComment as postNeedsHumanCommentImpl,
} from "@jigs/service/suspension/needs-human";
import {
  fetchPrState as fetchPrStateImpl,
  type GateFn,
  pullRequestGate,
} from "@jigs/service/suspension/pull-request-gate";
import {
  type TicketReviewOptions,
  ticketReview as ticketReviewJig,
} from "@jigs/service/ticket/review";
import { fetchSnapshot as fetchSnapshotImpl } from "@jigs/service/ticket/snapshot";
import {
  provisionRunWorktree,
  teardownRunWorktrees,
  type WorktreeRequest,
} from "@jigs/service/worktrees";
import type { WorktreeFacts } from "jigs";
import type { AgentStepConfig, AskStepConfig } from "jigs/steps";
import { getWorkflowMetadata } from "workflow";

// --- steps -----------------------------------------------------------------

export async function worktree(
  request: WorktreeRequest,
): Promise<WorktreeFacts> {
  "use step";
  return provisionRunWorktree(request, getWorkflowMetadata().workflowRunId);
}

export async function teardownWorktrees(outcome: { merged: boolean }) {
  "use step";
  return teardownRunWorktrees(getWorkflowMetadata().workflowRunId, outcome);
}

export async function runAgentStep(wire: Parameters<typeof runAgent>[0]) {
  "use step";
  return runAgent(wire, getWorkflowMetadata().workflowRunId);
}

export async function runAskStep(wire: Parameters<typeof runAsk>[0]) {
  "use step";
  return runAsk(wire, getWorkflowMetadata().workflowRunId);
}

export async function postNeedsHumanComment(
  ...args: Parameters<typeof postNeedsHumanCommentImpl>
) {
  "use step";
  return postNeedsHumanCommentImpl(...args);
}

export async function checkForHumanReply(
  ...args: Parameters<typeof checkForHumanReplyImpl>
) {
  "use step";
  return checkForHumanReplyImpl(...args);
}

export async function fetchPrState(
  ...args: Parameters<typeof fetchPrStateImpl>
) {
  "use step";
  return fetchPrStateImpl(...args);
}

export async function fetchSnapshot(
  ...args: Parameters<typeof fetchSnapshotImpl>
) {
  "use step";
  return fetchSnapshotImpl(...args);
}

export async function resolveRepo(...args: Parameters<typeof resolveRepoImpl>) {
  "use step";
  return resolveRepoImpl(...args);
}

export async function pushWorktreeBranch(
  ...args: Parameters<typeof pushWorktreeBranchImpl>
) {
  "use step";
  return pushWorktreeBranchImpl(...args);
}

export async function readDiff(...args: Parameters<typeof readDiffImpl>) {
  "use step";
  return readDiffImpl(...args);
}

export async function openPr(...args: Parameters<typeof openPrImpl>) {
  "use step";
  return openPrImpl(...args);
}

export async function replyInThread(
  ...args: Parameters<typeof replyInThreadImpl>
) {
  "use step";
  return replyInThreadImpl(...args);
}

export async function commentOnPr(...args: Parameters<typeof commentOnPrImpl>) {
  "use step";
  return commentOnPrImpl(...args);
}

export async function squashMerge(...args: Parameters<typeof squashMergeImpl>) {
  "use step";
  return squashMergeImpl(...args);
}

// --- jigs ------------------------------------------------------------------
//
// Workflow-side compositions, each holding the steps above. They carry no
// directive and no id: only the steps they call are memoized.

export function agent<T = undefined>(config: AgentStepConfig<T>) {
  return agentJig(config, runAgentStep);
}

export function ask<T = undefined>(config: AskStepConfig<T>) {
  return askJig(config, runAskStep);
}

export const needsHuman: NeedsHumanFn = (claim, reason, payload) =>
  needsHumanJig(claim, reason, payload, {
    postComment: postNeedsHumanComment,
    checkForReply: checkForHumanReply,
  });

export const gate: GateFn = (pr) => pullRequestGate(pr, fetchPrState);

export function agentOrHalt<T = undefined>(
  claim: TicketClaim,
  config: AgentStepConfig<T>,
) {
  return agentOrHaltJig(claim, config, { agent, needsHuman });
}

export function ticketReview(options: TicketReviewOptions) {
  return ticketReviewJig(options, { agent, needsHuman });
}

export function reviewLoop(options: ReviewLoopOptions) {
  return reviewLoopJig(options, {
    agent,
    needsHuman,
    gate,
    resolveRepo,
    pushWorktreeBranch,
    openPr,
    replyInThread,
    commentOnPr,
    squashMerge,
    readDiff,
    teardownRun: teardownWorktrees,
  });
}
