// The review loop jig (ADR 0009): implement ⇄ agent review until approved,
// then a pull request whose human review the builder answers, whose red CI the
// builder fixes under a bound, and whose close ends the run under ADR 0007's
// teardown matrix.

import type { WorktreeFacts } from "jigs";
import type { HarnessConfig } from "jigs/steps";
import type { CheckRun } from "../providers/github";
import type { AgentFn } from "../steps";
import type { TicketClaim } from "../suspension/claim";
import type { NeedsHumanFn } from "../suspension/needs-human";
import type { GateFn } from "../suspension/pull-request-gate";
import type { PrRef } from "../suspension/tokens";
import type { Handoff } from "../ticket/review";
import { answerAsBuilder, type ThreadAnswers } from "./builder";
import { fixCi, renderChecks } from "./fix-ci";
import { implementAndReview } from "./implement";
import type {
  commentOnPr,
  openPr,
  pushWorktreeBranch,
  readDiff,
  replyInThread,
  resolveRepo,
  squashMerge,
} from "./pull-request";

export class PrClosedUnmergedError extends Error {
  constructor(pr: PrRef) {
    super(
      `pull request ${pr.owner}/${pr.repo}#${pr.number} was closed without merging`,
    );
    this.name = "PrClosedUnmergedError";
  }
}

// Here rather than beside pushWorktreeBranch, which reports the empty branch:
// ./pull-request imports node builtins at module scope, so nothing
// workflow-side can import a value from it. The loop is what turns an empty
// push into a failure anyway.
export class EmptyBranchError extends Error {
  constructor(branch: string, baseSha: string) {
    super(
      `${branch} holds no commits since ${baseSha} — the builder finished without committing, so there is nothing to open a pull request for`,
    );
    this.name = "EmptyBranchError";
  }
}

export interface ReviewLoopOptions {
  claim: TicketClaim;
  handoff: Handoff;
  harness: HarnessConfig;
  worktree: WorktreeFacts;
  binding: string;
  // "human" keeps listening after an approval and lets a person press merge;
  // the gate ends either way only when the PR closes.
  merge?: "jigs" | "human";
  maxReviewCycles?: number;
  maxCiAttempts?: number;
  reviewPrompt?: string;
}

export type ReviewLoopResult = {
  pr: PrRef;
  cycles: number;
};

// Workflow-side only: these never cross the step serialization boundary. The
// factory constructs this object, binding each entry to its own "use step"
// wrapper — a jig imported from a package cannot own the steps it calls
// without baking this package's version into their ids.
export type ReviewLoopDeps = {
  agent: AgentFn;
  needsHuman: NeedsHumanFn;
  gate: GateFn;
  resolveRepo: typeof resolveRepo;
  pushWorktreeBranch: typeof pushWorktreeBranch;
  openPr: typeof openPr;
  replyInThread: typeof replyInThread;
  commentOnPr: typeof commentOnPr;
  squashMerge: typeof squashMerge;
  readDiff: typeof readDiff;
  teardownRun: (outcome: { merged: boolean }) => Promise<string[]>;
};

export async function reviewLoop(
  options: ReviewLoopOptions,
  deps: ReviewLoopDeps,
): Promise<ReviewLoopResult> {
  const { handoff, worktree } = options;
  const maxCiAttempts = options.maxCiAttempts ?? 3;
  const title = `${handoff.snapshot.identifier} ${handoff.snapshot.title}`;
  // Destructured, never invoked as `deps.step(...)`: the SDK serializes a step
  // call's receiver along with its arguments, and this object holds functions.
  const {
    commentOnPr,
    openPr,
    pushWorktreeBranch,
    replyInThread,
    resolveRepo,
    squashMerge,
    teardownRun,
  } = deps;

  const built = await implementAndReview(
    {
      claim: options.claim,
      handoff,
      harness: options.harness,
      cwd: worktree.path,
      baseSha: worktree.baseSha,
      ...(options.maxReviewCycles === undefined
        ? {}
        : { maxCycles: options.maxReviewCycles }),
      ...(options.reviewPrompt === undefined
        ? {}
        : { reviewPrompt: options.reviewPrompt }),
    },
    { agent: deps.agent, needsHuman: deps.needsHuman },
  );
  let session = built.session;

  const pushed = await pushWorktreeBranch(
    worktree.path,
    worktree.branch,
    worktree.baseSha,
  );
  // Thrown workflow-side, so the SDK does not retry an empty push three times.
  if (pushed.commits === 0) {
    // The one failure the jig raises itself, so it follows the failed-run rows
    // rather than waiting on the sweep timer like a run that dies mid-body.
    await teardownRun({ merged: false });
    throw new EmptyBranchError(worktree.branch, worktree.baseSha);
  }

  const repo = await resolveRepo(options.binding);
  const pr = await openPr(
    repo,
    worktree.branch,
    worktree.defaultBranch,
    title,
    prBody(handoff),
  );

  let ciAttempts = 0;
  for await (const wake of deps.gate(pr)) {
    switch (wake.kind) {
      case "review-comments":
      case "changes-requested": {
        const threads = wake.kind === "review-comments" ? wake.threads : [];
        const answered = await answerAsBuilder(
          {
            harness: options.harness,
            cwd: worktree.path,
            ...(session === undefined ? {} : { session }),
            threads,
            ...(wake.body === undefined ? {} : { reviewBody: wake.body }),
            handoff,
            baseSha: worktree.baseSha,
          },
          { agent: deps.agent, readDiff: deps.readDiff },
        );
        session = answered.session ?? session;
        // The answer prompts tell the builder to commit its fix before
        // replying, so the reply is only true once the branch carries it.
        await pushWorktreeBranch(
          worktree.path,
          worktree.branch,
          worktree.baseSha,
        );
        // Anything the model names that this wake did not carry is invented:
        // replying into it 404s, and a 404 burns the step's three retries.
        const known = new Set(threads.map((thread) => thread.rootId));
        await postAnswers(
          pr,
          answered.output,
          known,
          replyInThread,
          commentOnPr,
        );
        break;
      }
      case "ci-red": {
        ciAttempts += 1;
        if (ciAttempts > maxCiAttempts) {
          // Exactly once per red streak, and on GitHub rather than through
          // needsHuman: the conversation about this PR belongs on this PR.
          if (ciAttempts === maxCiAttempts + 1) {
            await commentOnPr(
              pr,
              escalation(wake.mentionLogin ?? pr.owner, wake, maxCiAttempts),
            );
          }
          break;
        }
        // A resumed fix runs inside the builder's own session and leaves the
        // pointer where it is; only the fresh-context rebuild becomes a new
        // session, and that one is then the one holding the change.
        const fixed = await fixCi(
          {
            harness: options.harness,
            cwd: worktree.path,
            ...(session === undefined ? {} : { session }),
            failing: wake.failing,
            attempt: `${ciAttempts} of ${maxCiAttempts}`,
            handoff,
            baseSha: worktree.baseSha,
          },
          { agent: deps.agent, readDiff: deps.readDiff },
        );
        session = fixed.session ?? session;
        const after = await pushWorktreeBranch(
          worktree.path,
          worktree.branch,
          worktree.baseSha,
        );
        // A fix that committed nothing pushes no new head, so CI never runs
        // again and no further wake can arrive: escalate now rather than wait
        // on a wake that cannot come. The bound is spent past its once-per-
        // streak comment so a later red in the same streak stays quiet.
        if (after.headSha === wake.headSha) {
          await commentOnPr(
            pr,
            noCommitEscalation(wake.mentionLogin ?? pr.owner, wake),
          );
          ciAttempts = maxCiAttempts + 1;
        }
        break;
      }
      case "ci-green":
        ciAttempts = 0;
        break;
      case "approved": {
        if (options.merge === "human") {
          console.log(
            `[reviewLoop] approved by ${wake.reviewer} — human-merges mode, waiting for the merge`,
          );
          break;
        }
        try {
          await squashMerge(pr, title);
        } catch (error) {
          // GitHub answers 405 for a PR that is not mergeable, and the arm
          // merges on approval without checking CI. Letting that escape would
          // end the run without its own teardown; breaking keeps the gate
          // listening so the eventual close tears the run down.
          await commentOnPr(pr, mergeFailure(wake.reviewer, error));
          break;
        }
        await teardownRun({ merged: true });
        return { pr, cycles: built.cycles };
      }
      case "closed": {
        await teardownRun({ merged: wake.merged });
        if (wake.merged) return { pr, cycles: built.cycles };
        throw new PrClosedUnmergedError(pr);
      }
    }
  }
  throw new Error(
    `the pull request gate for ${pr.owner}/${pr.repo}#${pr.number} stopped delivering wakes before the PR closed`,
  );
}

async function postAnswers(
  pr: PrRef,
  answers: ThreadAnswers,
  known: Set<number>,
  reply: typeof replyInThread,
  comment: typeof commentOnPr,
): Promise<void> {
  for (const answer of answers.answers) {
    if (answer.threadId !== null && !known.has(answer.threadId)) {
      console.log(
        `[reviewLoop] answer named unknown thread ${answer.threadId} — posting on the conversation instead`,
      );
    }
    if (answer.threadId === null || !known.has(answer.threadId)) {
      await comment(pr, answer.body);
    } else {
      await reply(pr, answer.threadId, answer.body);
    }
  }
}

function prBody(handoff: Handoff): string {
  return [
    `Implements [${handoff.snapshot.identifier}](${handoff.snapshot.url}) — ${handoff.snapshot.title}.`,
    "",
    "## Brief",
    "",
    handoff.brief,
  ].join("\n");
}

function escalation(
  login: string,
  wake: { headSha: string; failing: CheckRun[] },
  attempts: number,
): string {
  return [
    `@${login} CI is still red on \`${wake.headSha.slice(0, 8)}\` after ${attempts} fix attempts, so I am standing down rather than guessing again.`,
    "",
    renderChecks(wake.failing),
  ].join("\n");
}

function noCommitEscalation(
  login: string,
  wake: { headSha: string; failing: CheckRun[] },
): string {
  return [
    `@${login} my CI fix attempt produced no new commit on \`${wake.headSha.slice(0, 8)}\`, so nothing will re-run and I am standing down.`,
    "",
    renderChecks(wake.failing),
  ].join("\n");
}

function mergeFailure(login: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `@${login} I could not squash-merge this pull request: ${reason}. I am leaving it open and still listening — merge or close it yourself and I will follow.`;
}
