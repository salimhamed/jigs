// The review loop jig (ADR 0009): implement ⇄ agent review until approved,
// then a pull request whose human review the builder answers, whose red CI the
// builder fixes under a bound, and whose close ends the run. The loop returns
// only when the PR merged — every other ending throws — and it never cleans
// up: the pipeline calls teardownWorktrees after a merged return, and a thrown
// ending leaves the worktree for `jigs sweep` (ADR 0007).
//
// The factory owns PR presentation: `describePr` names the pull request and
// writes its body, and jigs carries no default for either.

import type { WorktreeFacts } from "jigs";
import { commitWorkPrompt } from "jigs/prompts";
import type { AgentSession, HarnessConfig } from "jigs/steps";
import type { CheckRun } from "../providers/github";
import { type AgentFn, ResumeFailedError } from "../steps";
import type { TicketClaim } from "../suspension/claim";
import type { NeedsHumanFn } from "../suspension/needs-human";
import type { GateAck, GateFn } from "../suspension/pull-request-gate";
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
  constructor(branch: string, baseSha: string, recovered = false) {
    super(
      `${branch} holds no commits since ${baseSha} — the builder finished without committing, so there is nothing to open a pull request for${
        recovered ? ", and a commit-recovery round did not change that" : ""
      }`,
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
}

const MAX_CI_ATTEMPTS = 3;

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
  // Not a `typeof` like its neighbours: jigs ships no implementation to point
  // at. How a pull request introduces itself is the factory's voice, so the
  // factory writes it — required, so a factory cannot forget to have one.
  describePr: (input: {
    handoff: Handoff;
    worktreePath: string;
    baseSha: string;
    session?: AgentSession;
  }) => Promise<{ title: string; body: string }>;
};

export async function reviewLoop(
  options: ReviewLoopOptions,
  deps: ReviewLoopDeps,
): Promise<ReviewLoopResult> {
  const { handoff, worktree } = options;
  // Destructured, never invoked as `deps.step(...)`: the SDK serializes a step
  // call's receiver along with its arguments, and this object holds functions.
  const {
    commentOnPr,
    describePr,
    openPr,
    pushWorktreeBranch,
    replyInThread,
    resolveRepo,
    squashMerge,
  } = deps;

  const built = await implementAndReview(
    {
      claim: options.claim,
      handoff,
      harness: options.harness,
      cwd: worktree.path,
      baseSha: worktree.baseSha,
    },
    { agent: deps.agent, needsHuman: deps.needsHuman },
  );
  let session = built.session;

  let pushed = await pushWorktreeBranch(
    worktree.path,
    worktree.branch,
    worktree.baseSha,
  );
  // Thrown workflow-side, so the SDK does not retry an empty push three times.
  // Like every thrown ending, it leaves the worktree behind for `jigs sweep`:
  // the loop never tears down (the pipeline calls teardownWorktrees after a
  // merged return; nothing cleans up a failure except the operator).
  if (pushed.commits === 0) {
    // A dirty tree is a complete implementation the builder forgot to commit —
    // an approved one, by the time the push runs — so it gets exactly one
    // bounded round to save it. A clean tree has nothing to save.
    if (!pushed.dirty) {
      throw new EmptyBranchError(worktree.branch, worktree.baseSha);
    }
    console.log(
      "[reviewLoop] empty push with dirty worktree — sending builder back to commit",
    );
    const committed = await commitLeftoverWork(deps.agent, {
      harness: options.harness,
      cwd: worktree.path,
      ...(session === undefined ? {} : { session }),
    });
    session = committed ?? session;
    pushed = await pushWorktreeBranch(
      worktree.path,
      worktree.branch,
      worktree.baseSha,
    );
    if (pushed.commits === 0) {
      throw new EmptyBranchError(worktree.branch, worktree.baseSha, true);
    }
  }

  // After the push, so nothing writes a description for a branch that turned
  // out to have nothing on it.
  const described = await describePr({
    handoff,
    worktreePath: worktree.path,
    baseSha: worktree.baseSha,
    ...(session === undefined ? {} : { session }),
  });

  const repo = await resolveRepo(options.binding);
  const pr = await openPr(
    repo,
    worktree.branch,
    worktree.defaultBranch,
    described.title,
    described.body,
  );

  let ciAttempts = 0;
  // Driven by hand rather than `for await`: the gate has to be told the ids of
  // the replies this loop posts, and only `next(ack)` can carry them back
  // (AGE-363). The finally is what `for await` did for free — ending the gate
  // on an early return disposes its hook.
  const gate = deps.gate(pr);
  let ack: GateAck | undefined;
  try {
    while (true) {
      const next = await gate.next(ack);
      if (next.done === true) break;
      ack = undefined;
      const wake = next.value;
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
          const posted = await postAnswers(
            pr,
            answered.output,
            known,
            replyInThread,
            commentOnPr,
          );
          if (posted.length > 0) ack = { selfCommentIds: posted };
          break;
        }
        case "ci-red": {
          ciAttempts += 1;
          if (ciAttempts > MAX_CI_ATTEMPTS) {
            // Exactly once per red streak, and on GitHub rather than through
            // needsHuman: the conversation about this PR belongs on this PR.
            if (ciAttempts === MAX_CI_ATTEMPTS + 1) {
              await commentOnPr(
                pr,
                escalation(
                  wake.mentionLogin ?? pr.owner,
                  wake,
                  MAX_CI_ATTEMPTS,
                ),
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
              attempt: `${ciAttempts} of ${MAX_CI_ATTEMPTS}`,
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
            ciAttempts = MAX_CI_ATTEMPTS + 1;
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
            await squashMerge(pr);
          } catch (error) {
            // GitHub answers 405 for a PR that is not mergeable, and the arm
            // merges on approval without checking CI. Letting that escape would
            // fail the run on a recoverable state; breaking keeps the gate
            // listening so the eventual close still ends the run.
            await commentOnPr(pr, mergeFailure(wake.reviewer, error));
            break;
          }
          return { pr, cycles: built.cycles };
        }
        case "closed": {
          if (wake.merged) return { pr, cycles: built.cycles };
          throw new PrClosedUnmergedError(pr);
        }
      }
    }
  } finally {
    await gate.return();
  }
  throw new Error(
    `the pull request gate for ${pr.owner}/${pr.repo}#${pr.number} stopped delivering wakes before the PR closed`,
  );
}

// Resume-first with the first-class fresh-context fallback the CI fix and the
// review answers have (ADR 0009), and no rebuilt context to go with it: the
// work this round commits is on disk in the cwd, so a fresh builder reading the
// worktree has everything the resumed one would have had.
async function commitLeftoverWork(
  agent: AgentFn,
  options: { harness: HarnessConfig; cwd: string; session?: AgentSession },
): Promise<AgentSession | undefined> {
  if (options.session !== undefined) {
    try {
      const resumed = await agent({
        harness: options.harness,
        cwd: options.cwd,
        permissionMode: "bypassPermissions",
        resume: options.session,
        prompt: commitWorkPrompt,
      });
      return resumed.session;
    } catch (err) {
      if (!(err instanceof ResumeFailedError)) throw err;
      console.log(
        "[reviewLoop] resume failed — committing from a fresh context",
      );
    }
  }

  const committed = await agent({
    harness: options.harness,
    cwd: options.cwd,
    permissionMode: "bypassPermissions",
    prompt: commitWorkPrompt,
  });
  return committed.session;
}

// Returns the ids of the thread replies it posted, for the gate's self guard.
// Conversation comments are left out: they never appear among the review
// threads the guard filters.
async function postAnswers(
  pr: PrRef,
  answers: ThreadAnswers,
  known: Set<number>,
  reply: typeof replyInThread,
  comment: typeof commentOnPr,
): Promise<number[]> {
  const posted: number[] = [];
  for (const answer of answers.answers) {
    if (answer.threadId !== null && !known.has(answer.threadId)) {
      console.log(
        `[reviewLoop] answer named unknown thread ${answer.threadId} — posting on the conversation instead`,
      );
    }
    if (answer.threadId === null || !known.has(answer.threadId)) {
      await comment(pr, answer.body);
    } else {
      posted.push((await reply(pr, answer.threadId, answer.body)).id);
    }
  }
  return posted;
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
