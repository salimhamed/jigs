import { defaultPullRequestScope, JigsError, renderChecks, type StatusReason } from "@jigs-ai/jigs";
import {
  type AgentSessionTurn,
  agentSession,
  postPullRequestNote,
  postReviewAnswers,
  pullRequestGate,
  runAgent,
} from "#jigs/routines";
import {
  mergePullRequest,
  openPullRequest,
  pushApprovedChange,
  pushBranch,
  readBranchState,
  readWorktreeDiff,
  registerResource,
  resolveRepository,
} from "#jigs/steps";
import { pullRequestDescription, type ThreadAnswers, threadAnswers } from "./outputs.ts";
import {
  defaultCiRepairPrompt,
  defaultDescriptionPrompt,
  defaultImplementationPrompt,
  defaultReviewPrompt,
  defaultRevisionPrompt,
} from "./prompts.ts";
import {
  type ImplementationReport,
  implementationReport,
  type ReviewFinding,
  type ReviewVerdict,
  renderFinding,
  reviewerNotes,
  reviewVerdict,
} from "./review.ts";
import type {
  CiRepairPromptContext,
  DeliverChangeOptions,
  DeliveryAgent,
  DeliveryCallbacks,
  DeliveryChange,
  DeliveryResult,
  FollowPullRequestOptions,
  ImplementAndReviewOptions,
  ImplementAndReviewResult,
  ImplementationPromptContext,
  LimitReached,
  OnDeliveryLimit,
  PostDeliveryNote,
  PublishApprovedChangeOptions,
  PullRequestRevisionPromptContext,
  ReviewPromptContext,
  WorkItem,
} from "./types.ts";

/** A role's context minus the renderer, which only `renderPrompt` can supply. */
type PromptFields<TContext> = Omit<TContext, "renderDefaultPrompt">;

function validateLimit(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
}

// The default renderer runs here or not at all: a role that replaces the
// prompt never pays for it, and a role that extends it gets the same text the
// default would have produced for this very attempt.
async function renderPrompt<TContext extends { renderDefaultPrompt: () => Promise<string> }>(
  role: DeliveryAgent<TContext>,
  renderDefault: (context: TContext) => string | Promise<string>,
  fields: PromptFields<TContext>,
): Promise<string> {
  const context: TContext = {
    ...fields,
    renderDefaultPrompt: async () => renderDefault(context),
  } as TContext;
  return (role.prompt ?? renderDefault)(context);
}

async function extendLimit<TTask extends WorkItem>(
  limit: LimitReached<TTask>,
  onLimit?: OnDeliveryLimit<TTask>,
) {
  if (onLimit === undefined) return { stop: true as const };
  const decision = await onLimit(limit);
  if (decision.action === "stop") return { stop: true as const };
  validateLimit(decision.additionalAttempts, "additionalAttempts", 1);
  return { additionalAttempts: decision.additionalAttempts, instructions: decision.instructions };
}

function uncommittedReason(dirty: boolean): string {
  return dirty
    ? "The implementation left uncommitted changes; only committed work is reviewed."
    : "The implementation added no commits since the base commit.";
}

function lazyDiff(change: DeliveryChange) {
  let diff: Promise<string> | undefined;
  return () => (diff ??= readWorktreeDiff(change.worktree.path, change.worktree.baseSha));
}

// A role's prompt renders inside the session's turn, so the fresh arm's extra
// context (a diff read is a step) costs nothing when the resume is taken.
function roleTurn<TContext extends { renderDefaultPrompt: () => Promise<string> }>(
  role: DeliveryAgent<TContext>,
  renderDefault: (context: TContext) => string | Promise<string>,
  resume: PromptFields<TContext>,
  fresh: () => Promise<PromptFields<TContext>>,
): AgentSessionTurn {
  return {
    resume: () => renderPrompt(role, renderDefault, resume),
    fresh: async () => renderPrompt(role, renderDefault, await fresh()),
  };
}

// A delivery that stops short first pushes, so the commits outlive `jigs
// sweep`, then says through `postNote` what is still open and where the work
// is. Nothing waits on a reply.
async function stopDelivery<TTask extends WorkItem>(
  change: DeliveryChange<TTask>,
  limit: LimitReached<TTask>,
  reason: string,
  options: { postNote: PostDeliveryNote; on?: DeliveryCallbacks },
): Promise<never> {
  await pushBranch(change.worktree.path, change.worktree.branch);
  await options.postNote({
    headline: reason,
    notes: [
      ...limit.findings,
      `The work is on branch \`${change.worktree.branch}\`, pushed, in the worktree at \`${change.worktree.path}\`.`,
    ],
    closing:
      "Nothing is waiting on a reply here. Settle the open findings and start the run again, or take the branch over by hand.",
  });
  await options.on?.stopped?.(reason);
  throw new JigsError(
    `${reason} The work is pushed on branch ${change.worktree.branch}.`,
    limit.findings.length === 0 ? undefined : limit.findings.join("\n"),
  );
}

/** Implement and independently review until approved or the configured budget is exhausted. */
export async function implementAndReview<TTask extends WorkItem = WorkItem>(
  options: ImplementAndReviewOptions<TTask>,
): Promise<ImplementAndReviewResult<TTask>> {
  validateLimit(options.limits.implementationReviewRounds, "implementationReviewRounds");
  const change: DeliveryChange<TTask> = {
    task: options.task,
    worktree: options.worktree,
    attempts: { implementationReviewRounds: 0, ciFixAttempts: 0, pullRequestRevisionRounds: 0 },
    review: [],
  };
  const cwd = change.worktree.path;
  const builderSession = agentSession({
    name: "builder",
    harness: options.implementation.harness,
    cwd,
  });
  const reviewerSession = agentSession({ name: "reviewer", harness: options.review.harness, cwd });
  let budget = options.limits.implementationReviewRounds;
  let findings: ReviewFinding[] = [];
  let instructions = "";
  for (;;) {
    if (change.attempts.implementationReviewRounds >= budget) {
      const limit: LimitReached<TTask> = {
        task: change.task,
        worktree: change.worktree,
        phase: "implementation-review",
        attempts: change.attempts.implementationReviewRounds,
        findings: findings.map(renderFinding),
      };
      const extension = await extendLimit(limit, options.onLimit);
      if ("stop" in extension)
        return stopDelivery(
          change,
          limit,
          `jigs stopped work on ${change.task.key} after ${limit.attempts} implementation review round(s) without an approved change.`,
          options,
        );
      budget += extension.additionalAttempts;
      instructions = extension.instructions;
    }
    change.attempts.implementationReviewRounds += 1;
    const round = change.attempts.implementationReviewRounds;
    const built: PromptFields<ImplementationPromptContext<TTask>> = {
      task: change.task,
      worktree: change.worktree,
      attempt: round,
      findings,
      instructions,
    };
    const report: ImplementationReport = await builderSession.run({
      ...roleTurn(options.implementation, defaultImplementationPrompt, built, async () => ({
        ...built,
        readDiff: lazyDiff(change),
      })),
      output: implementationReport,
    });
    const state = await readBranchState(change.worktree.path, change.worktree.baseSha);
    if (state.dirty || state.commits === 0) {
      const reason = uncommittedReason(state.dirty);
      return stopDelivery(
        change,
        {
          task: change.task,
          worktree: change.worktree,
          phase: "implementation-review",
          attempts: round,
          findings: [reason],
        },
        `jigs stopped work on ${change.task.key} during implementation review round ${round}. ${reason}`,
        options,
      );
    }
    const reviewed: PromptFields<ReviewPromptContext<TTask>> = {
      task: change.task,
      worktree: change.worktree,
      attempt: round,
      baseCommit: change.worktree.baseSha,
      headCommit: state.headSha,
      diff: await readWorktreeDiff(change.worktree.path, change.worktree.baseSha),
      instructions,
      responses: report.responses,
    };
    // Read before the round is recorded, so the ledger a rebuilt reviewer
    // gets is the rounds it has already judged and not this one.
    const ledger = [...change.review];
    const verdict: ReviewVerdict = await reviewerSession.run({
      ...roleTurn(options.review, defaultReviewPrompt, reviewed, async () => ({
        ...reviewed,
        ledger,
      })),
      output: reviewVerdict,
    });
    findings = verdict.findings;
    // `blocking` decides, not the stated verdict: an approval carrying a
    // blocking finding is the reviewer contradicting itself, and the finding
    // is the more specific claim. It is also what makes a round of pure
    // preferences an approval rather than another trip through the builder.
    const blocking = findings.filter((finding) => finding.blocking).length;
    const decided = blocking === 0 ? "approved" : "changes-requested";
    change.review.push({ round, responses: report.responses, verdict: decided, findings });
    console.log(
      `[implementAndReview] ${change.task.key} round ${round} verdict=${decided} blocking=${blocking} non-blocking=${findings.length - blocking}`,
    );
    if (decided === "approved") {
      return {
        change: { ...change, approval: { reviewedCommit: state.headSha } },
      };
    }
  }
}

/** Push the reviewed commit and open a pull request with a separate description agent. */
export async function publishApprovedChange<TTask extends WorkItem = WorkItem>(
  options: PublishApprovedChangeOptions<TTask>,
) {
  const { change } = options;
  const { path, baseSha, branch, defaultBranch } = change.worktree;
  const { reviewedCommit } = change.approval;
  await pushApprovedChange(path, branch, reviewedCommit);
  const role = options.pullRequestDescription ?? { harness: options.implementation.harness };
  const result = await runAgent({
    harness: role.harness,
    cwd: path,
    prompt: await renderPrompt(role, defaultDescriptionPrompt, {
      task: change.task,
      worktree: change.worktree,
      diff: await readWorktreeDiff(path, baseSha),
    }),
    output: pullRequestDescription,
  });
  const description = pullRequestDescription.parse(
    role.transform?.(result.output, change.task) ?? result.output,
  );
  const repository = await resolveRepository(options.binding);
  // Appended here rather than asked of the description agent: the reviewer's
  // remaining observations are the one part of the body a model must not be
  // free to leave out.
  const notes = reviewerNotes(change.review);
  const body =
    notes.length === 0
      ? description.body
      : `${description.body}\n\n## Reviewer notes\n\nThe reviewer approved this change and left these non-blocking observations:\n\n${notes.map((note) => `- ${note}`).join("\n")}`;
  const pullRequest = await openPullRequest({
    repo: repository,
    head: branch,
    base: defaultBranch,
    title: description.title,
    body,
  });
  await registerResource({
    kind: "pull-request",
    identity: `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`,
    url: pullRequest.url,
  });
  await options.on?.pullRequestOpened?.(pullRequest);
  return pullRequest;
}

/** Address CI and review feedback until merge, closure, or an exhausted attempt budget. */
export async function followPullRequest<TTask extends WorkItem = WorkItem>(
  options: FollowPullRequestOptions<TTask>,
): Promise<DeliveryResult<TTask>> {
  validateLimit(options.limits.ciFixAttempts, "ciFixAttempts");
  validateLimit(options.limits.pullRequestRevisionRounds, "pullRequestRevisionRounds");
  const { change, pr } = options;
  const scope = options.scope ?? defaultPullRequestScope(change.task.key);
  const budgets = { ...options.limits };
  const instructions = { ciFixAttempts: "", pullRequestRevisionRounds: "" };
  const note = (reason: StatusReason, headSha: string, body: string) =>
    postPullRequestNote({ pr, scope, reason, headSha, body });
  const cwd = change.worktree.path;
  const ciRepair = options.ciRepair ?? { harness: options.implementation.harness };
  const pullRequestRevision = options.pullRequestRevision ?? {
    harness: options.implementation.harness,
  };
  const ciRepairSession = agentSession({ name: "ciRepair", harness: ciRepair.harness, cwd });
  const revisionSession = agentSession({
    name: "pullRequestRevision",
    harness: pullRequestRevision.harness,
    cwd,
  });
  const gate = pullRequestGate(pr, {
    scope,
    approval: options.merge.approval,
    worktree: change.worktree,
  });
  for await (const wake of gate) {
    if (wake.kind === "closed") {
      if (wake.merged) {
        await options.on?.merged?.(pr);
        return { change, pr };
      }
      return stopDelivery(
        change,
        {
          task: change.task,
          worktree: change.worktree,
          pr,
          phase: "pull-request-revision",
          attempts: change.attempts.pullRequestRevisionRounds,
          findings: [],
        },
        `jigs stopped work on ${change.task.key} because pull request ${pr.owner}/${pr.repo}#${pr.number} was closed unmerged.`,
        options,
      );
    }
    if (wake.kind === "merge-ready") {
      if (options.merge.by === "human") continue;
      let refused: { reason: string; transient: boolean };
      try {
        const result = await mergePullRequest(pr, wake.headSha, options.merge);
        if (result.merged) {
          await options.on?.merged?.(pr);
          return { change, pr };
        }
        refused = result;
      } catch (error) {
        // An unclassified error may pass, so leave the head eligible to retry.
        refused = { reason: String(error), transient: true };
      }
      if (!refused.transient) {
        // The note is what stands this commit down: without it the same
        // approval reads as unfinished work on every later wake.
        await note(
          "merge",
          wake.headSha,
          `I could not merge this pull request: ${refused.reason}. I am standing down on ${wake.headSha}: nothing I can do here changes that, so it needs a new commit or a change to the repository.`,
        );
      } else {
        // Posted once per commit however often it is retried, and with a
        // reason the gate does not read as a stand-down, so this commit stays
        // merge-ready.
        await note(
          "merge-retry",
          wake.headSha,
          `I could not merge this pull request yet: ${refused.reason}. I will try again when GitHub reports a change, and I will not repeat this note for ${wake.headSha}.`,
        );
      }
      continue;
    }
    const ci = wake.kind === "ci-red";
    const counter = ci ? "ciFixAttempts" : "pullRequestRevisionRounds";
    const phase = ci ? "ci-repair" : "pull-request-revision";
    const findings = ci
      ? wake.failing.map((check) => `${check.name}: ${check.conclusion}`)
      : [wake.body ?? "Address the pull request review threads."];
    if (change.attempts[counter] >= budgets[counter]) {
      const limit: LimitReached<TTask> = {
        task: change.task,
        worktree: change.worktree,
        pr,
        phase,
        attempts: change.attempts[counter],
        findings,
      };
      const extension = await extendLimit(limit, options.onLimit);
      if ("stop" in extension)
        return stopDelivery(
          change,
          limit,
          `jigs stopped work on ${change.task.key} after ${limit.attempts} ${phase} attempt(s).`,
          options,
        );
      budgets[counter] += extension.additionalAttempts;
      instructions[counter] = extension.instructions;
    }
    change.attempts[counter] += 1;
    const shared = {
      task: change.task,
      worktree: change.worktree,
      pr,
      attempt: change.attempts[counter],
      instructions: instructions[counter],
    };
    if (wake.kind === "ci-red") {
      const repairing: PromptFields<CiRepairPromptContext<TTask>> = {
        ...shared,
        failing: wake.failing,
      };
      await ciRepairSession.run(
        roleTurn(ciRepair, defaultCiRepairPrompt, repairing, async () => ({
          ...repairing,
          readDiff: lazyDiff(change),
        })),
      );
      const state = await readBranchState(change.worktree.path, change.worktree.baseSha);
      if (state.headSha === wake.headSha || state.dirty) {
        // Marked as given up on: this red head is settled, so a later run
        // attending the same pull request does not spend its budget on it
        // again.
        await note(
          "ci",
          wake.headSha,
          `I could not repair the failing checks on ${wake.headSha}.\n\n${renderChecks(wake.failing)}`,
        );
        return stopDelivery(
          change,
          {
            task: change.task,
            worktree: change.worktree,
            pr,
            phase,
            attempts: change.attempts[counter],
            findings: ["The CI repair did not produce a clean, new commit."],
          },
          `jigs stopped work on ${change.task.key} because CI repair attempt ${change.attempts[counter]} produced no new clean commit.`,
          options,
        );
      }
      await pushBranch(change.worktree.path, change.worktree.branch);
      continue;
    }
    const threads = wake.kind === "review-comments" ? wake.threads : [];
    const revising: PromptFields<PullRequestRevisionPromptContext<TTask>> = {
      ...shared,
      threads,
      reviewBody: wake.body,
    };
    const startingState = await readBranchState(change.worktree.path, change.worktree.baseSha);
    const answers: ThreadAnswers = await revisionSession.run({
      ...roleTurn(pullRequestRevision, defaultRevisionPrompt, revising, async () => ({
        ...revising,
        readDiff: lazyDiff(change),
      })),
      output: threadAnswers,
    });
    const state = await readBranchState(change.worktree.path, change.worktree.baseSha);
    if (state.dirty) throw new Error("Pull request revision left uncommitted changes");
    await pushBranch(change.worktree.path, change.worktree.branch);
    await postReviewAnswers({
      pr,
      scope,
      answers,
      committedSha: state.headSha === startingState.headSha ? undefined : state.headSha,
      threads,
    });
  }
  throw new Error(
    `the pull request gate for ${pr.owner}/${pr.repo}#${pr.number} stopped delivering wakes before the PR closed`,
  );
}

/** Deliver a work item using configurable agents, budgets, and merge policy. */
export async function deliverChange<TTask extends WorkItem = WorkItem>(
  options: DeliverChangeOptions<TTask>,
): Promise<DeliveryResult<TTask>> {
  validateLimit(options.limits.ciFixAttempts, "ciFixAttempts");
  validateLimit(options.limits.pullRequestRevisionRounds, "pullRequestRevisionRounds");
  const built = await implementAndReview(options);
  const pr = await publishApprovedChange({ ...options, change: built.change });
  return followPullRequest({ ...options, change: built.change, pr });
}
