import type { z } from "zod";
import { resumeOrRebuild } from "../agent/resume-or-rebuild.ts";
import { type ThreadAnswers, threadAnswers } from "../builder-agent/answer-review.ts";
import { pullRequestDescription } from "../builder-agent/describe-pr.ts";
import { codeReviewVerdict } from "../builder-agent/implement.ts";
import { postReviewAnswers } from "../pull-request/answers.ts";
import { attend, finished, listen } from "../pull-request/attend.ts";
import {
  defaultCiRepairPrompt,
  defaultDescriptionPrompt,
  defaultImplementationPrompt,
  defaultReviewPrompt,
  defaultRevisionPrompt,
} from "./prompts.ts";
import type {
  AgentRoleName,
  CiRepairPromptContext,
  DeliverChangeOptions,
  DeliveryAgent,
  DeliveryChange,
  DeliveryLimit,
  DeliveryResult,
  DeliverySteps,
  DeliveryStopped,
  FollowPullRequestOptions,
  ImplementAndReviewOptions,
  ImplementAndReviewResult,
  ImplementationPromptContext,
  OnDeliveryLimit,
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
  renderDefault: (context: TContext) => string,
  fields: PromptFields<TContext>,
): Promise<string> {
  const context: TContext = {
    ...fields,
    renderDefaultPrompt: async () => renderDefault(context),
  } as TContext;
  return (role.prompt ?? renderDefault)(context);
}

async function extendLimit<TTask extends WorkItem>(
  limit: DeliveryLimit<TTask>,
  onLimit?: OnDeliveryLimit<TTask>,
) {
  if (onLimit === undefined) return { status: "limit-reached" as const };
  const decision = await onLimit(limit);
  if (decision.action === "stop") return { status: "stopped" as const };
  validateLimit(decision.additionalAttempts, "additionalAttempts", 1);
  return { additionalAttempts: decision.additionalAttempts, instructions: decision.instructions };
}

function stopped<TTask extends WorkItem>(
  change: DeliveryChange<TTask>,
  limit: DeliveryLimit<TTask>,
  status: DeliveryStopped["status"],
): DeliveryStopped<TTask> {
  return {
    status,
    phase: limit.phase,
    attempts: limit.attempts,
    findings: limit.findings,
    change,
    ...(limit.pr === undefined ? {} : { pr: limit.pr }),
  };
}

function uncommittedReason(dirty: boolean): string {
  return dirty
    ? "The implementation left uncommitted changes; only committed work is reviewed."
    : "The implementation added no commits since the base commit.";
}

/** Bind factory steps to delivery phases. Worktrees remain available on every return path. */
export function bindDeliverySteps(steps: DeliverySteps) {
  const {
    runAgent,
    pullRequestGate,
    readBranchState,
    readWorktreeDiff,
    pushBranch,
    resolveRepository,
    openPullRequest,
    commentOnPullRequest,
    replyToPullRequestReviewThread,
    squashMergePullRequest,
  } = steps;

  interface RoleRun<TTask extends WorkItem, TContext, T> {
    change: DeliveryChange<TTask>;
    name: AgentRoleName;
    role: DeliveryAgent<TContext>;
    renderDefault: (context: TContext) => string;
    /** The job as stated to the agent that already holds the change. */
    resume: PromptFields<TContext>;
    /** The same job for an agent holding nothing. Deferred: the diff read is a step. */
    fresh: () => Promise<PromptFields<TContext>>;
    output?: z.ZodType<T>;
  }

  async function runRole<
    TTask extends WorkItem,
    TContext extends { renderDefaultPrompt: () => Promise<string> },
    T = undefined,
  >(run: RoleRun<TTask, TContext, T>) {
    const { change, name, role, renderDefault } = run;
    const saved = change.sessions[name];
    const session =
      saved !== undefined && JSON.stringify(saved.harness) === JSON.stringify(role.harness)
        ? saved.session
        : undefined;
    const result = await resumeOrRebuild({
      runAgent,
      harness: role.harness,
      cwd: change.worktree.path,
      ...(session === undefined ? {} : { session }),
      resumePrompt: () => renderPrompt(role, renderDefault, run.resume),
      freshPrompt: async () => renderPrompt(role, renderDefault, await run.fresh()),
      ...(run.output === undefined ? {} : { output: run.output }),
      label: `delivery:${name}`,
    });
    if (result.session !== undefined) {
      change.sessions[name] = { harness: role.harness, session: result.session };
    } else {
      delete change.sessions[name];
    }
    return result.output;
  }

  /** Implement and independently review until approved or the configured budget is exhausted. */
  async function implementAndReview<TTask extends WorkItem = WorkItem>(
    options: ImplementAndReviewOptions<TTask>,
  ): Promise<ImplementAndReviewResult<TTask>> {
    validateLimit(options.limits.implementationReviewRounds, "implementationReviewRounds");
    const change: DeliveryChange<TTask> = {
      task: options.task,
      worktree: options.worktree,
      attempts: { implementationReviewRounds: 0, ciFixAttempts: 0, pullRequestRevisionRounds: 0 },
      sessions: {},
    };
    let budget = options.limits.implementationReviewRounds;
    let findings: string[] = [];
    let instructions = "";
    for (;;) {
      if (change.attempts.implementationReviewRounds >= budget) {
        const limit: DeliveryLimit<TTask> = {
          task: change.task,
          worktree: change.worktree,
          phase: "implementation-review",
          attempts: change.attempts.implementationReviewRounds,
          findings,
        };
        const extension = await extendLimit(limit, options.onLimit);
        if (extension.status !== undefined) return stopped(change, limit, extension.status);
        budget += extension.additionalAttempts;
        instructions = extension.instructions;
      }
      change.attempts.implementationReviewRounds += 1;
      const built: PromptFields<ImplementationPromptContext<TTask>> = {
        task: change.task,
        worktree: change.worktree,
        attempt: change.attempts.implementationReviewRounds,
        findings,
        instructions,
      };
      await runRole<TTask, ImplementationPromptContext<TTask>>({
        change,
        name: "implementation",
        role: options.implementation,
        renderDefault: defaultImplementationPrompt,
        resume: built,
        fresh: async () => ({
          ...built,
          diff: await readWorktreeDiff(change.worktree.path, change.worktree.baseSha),
        }),
      });
      const state = await readBranchState(change.worktree.path, change.worktree.baseSha);
      if (state.dirty || state.commits === 0) {
        return stopped(
          change,
          {
            task: change.task,
            worktree: change.worktree,
            phase: "implementation-review",
            attempts: change.attempts.implementationReviewRounds,
            findings: [uncommittedReason(state.dirty)],
          },
          "uncommitted-work",
        );
      }
      const reviewed: PromptFields<ReviewPromptContext<TTask>> = {
        task: change.task,
        worktree: change.worktree,
        attempt: change.attempts.implementationReviewRounds,
        baseCommit: change.worktree.baseSha,
        headCommit: state.headSha,
        diff: await readWorktreeDiff(change.worktree.path, change.worktree.baseSha),
        instructions,
      };
      const verdict = await runAgent({
        harness: options.review.harness,
        cwd: change.worktree.path,
        prompt: await renderPrompt(options.review, defaultReviewPrompt, reviewed),
        output: codeReviewVerdict,
      });
      findings = verdict.output.findings;
      if (verdict.output.verdict === "approved") {
        return {
          status: "approved",
          change: { ...change, approval: { reviewedCommit: state.headSha } },
        };
      }
    }
  }

  /** Push the reviewed commit and open a pull request with a separate description agent. */
  async function publishApprovedChange<TTask extends WorkItem = WorkItem>(
    options: PublishApprovedChangeOptions<TTask>,
  ) {
    const { change } = options;
    const { path, baseSha, branch, defaultBranch } = change.worktree;
    const { reviewedCommit } = change.approval;
    const state = await readBranchState(path, baseSha);
    if (state.dirty) {
      throw new Error(
        `Cannot publish ${branch}: the worktree has uncommitted changes that no review approved`,
      );
    }
    if (state.headSha !== reviewedCommit) {
      throw new Error(
        `Cannot publish ${branch}: ${state.headSha} is not the approved commit ${reviewedCommit}`,
      );
    }
    await pushBranch(path, branch);
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
    return openPullRequest(repository, branch, defaultBranch, description.title, description.body);
  }

  /** Address CI and review feedback until merge, closure, or an exhausted attempt budget. */
  async function followPullRequest<TTask extends WorkItem = WorkItem>(
    options: FollowPullRequestOptions<TTask>,
  ): Promise<DeliveryResult<TTask>> {
    validateLimit(options.limits.ciFixAttempts, "ciFixAttempts");
    validateLimit(options.limits.pullRequestRevisionRounds, "pullRequestRevisionRounds");
    const { change, pr } = options;
    const budgets = { ...options.limits };
    const instructions = { ciFixAttempts: "", pullRequestRevisionRounds: "" };
    const seenRed = new Set<string>();
    const seenReviews = new Set<number>();
    const seenComments = new Set<number>();
    return attend<DeliveryResult<TTask>>(pullRequestGate(pr), async (wake) => {
      if (wake.kind === "closed") {
        return finished({ status: wake.merged ? "merged" : "closed", change, pr });
      }
      if (wake.kind === "ci-green" || wake.kind === "approved") return listen();
      if (wake.kind === "merge-ready") {
        if (options.merge === "human") return listen();
        try {
          const result = await squashMergePullRequest(pr, wake.headSha);
          if (result.merged) return finished({ status: "merged", change, pr });
        } catch (error) {
          await commentOnPullRequest(
            pr,
            `I could not merge this pull request: ${String(error)}. I am still watching for updates.`,
          );
        }
        return listen();
      }
      if (wake.kind === "ci-red") {
        const current = await readBranchState(change.worktree.path, change.worktree.baseSha);
        if (current.headSha !== wake.headSha) return listen();
        if (seenRed.has(wake.headSha)) return listen();
        seenRed.add(wake.headSha);
      } else if (wake.kind === "changes-requested") {
        if (seenReviews.has(wake.reviewId)) return listen();
        seenReviews.add(wake.reviewId);
      } else {
        const ids = wake.threads.flatMap((thread) => thread.comments.map((comment) => comment.id));
        if (ids.length > 0 && ids.every((id) => seenComments.has(id))) return listen();
        for (const id of ids) seenComments.add(id);
      }
      const ci = wake.kind === "ci-red";
      const counter = ci ? "ciFixAttempts" : "pullRequestRevisionRounds";
      const phase = ci ? "ci-repair" : "pull-request-revision";
      const findings = ci
        ? wake.failing.map((check) => `${check.name}: ${check.conclusion}`)
        : [wake.body ?? "Address the pull request review threads."];
      if (change.attempts[counter] >= budgets[counter]) {
        const limit: DeliveryLimit<TTask> = {
          task: change.task,
          worktree: change.worktree,
          pr,
          phase,
          attempts: change.attempts[counter],
          findings,
        };
        const extension = await extendLimit(limit, options.onLimit);
        if (extension.status !== undefined)
          return finished(stopped(change, limit, extension.status));
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
      const withDiff = async () => ({
        diff: await readWorktreeDiff(change.worktree.path, change.worktree.baseSha),
      });
      if (wake.kind === "ci-red") {
        const repairing: PromptFields<CiRepairPromptContext<TTask>> = {
          ...shared,
          failing: wake.failing,
        };
        await runRole<TTask, CiRepairPromptContext<TTask>>({
          change,
          name: "ciRepair",
          role: options.ciRepair ?? { harness: options.implementation.harness },
          renderDefault: defaultCiRepairPrompt,
          resume: repairing,
          fresh: async () => ({ ...repairing, ...(await withDiff()) }),
        });
        const state = await readBranchState(change.worktree.path, change.worktree.baseSha);
        if (state.headSha === wake.headSha || state.dirty) {
          return finished(
            stopped(
              change,
              {
                task: change.task,
                worktree: change.worktree,
                pr,
                phase,
                attempts: change.attempts[counter],
                findings: ["The CI repair did not produce a clean, new commit."],
              },
              "stopped",
            ),
          );
        }
        await pushBranch(change.worktree.path, change.worktree.branch);
        return listen();
      }
      const threads = wake.kind === "review-comments" ? wake.threads : [];
      const revising: PromptFields<PullRequestRevisionPromptContext<TTask>> = {
        ...shared,
        threads,
        ...(wake.body === undefined ? {} : { reviewBody: wake.body }),
      };
      const answers = await runRole<TTask, PullRequestRevisionPromptContext<TTask>, ThreadAnswers>({
        change,
        name: "pullRequestRevision",
        role: options.pullRequestRevision ?? { harness: options.implementation.harness },
        renderDefault: defaultRevisionPrompt,
        resume: revising,
        fresh: async () => ({ ...revising, ...(await withDiff()) }),
        output: threadAnswers,
      });
      const state = await readBranchState(change.worktree.path, change.worktree.baseSha);
      if (state.dirty) throw new Error("Pull request revision left uncommitted changes");
      await pushBranch(change.worktree.path, change.worktree.branch);
      const ids = await postReviewAnswers({
        commentOnPullRequest,
        replyToPullRequestReviewThread,
        pr,
        answers,
        threads,
      });
      return listen({ selfCommentIds: ids });
    });
  }

  /** Deliver a work item using configurable agents, budgets, and merge policy. */
  async function deliverChange<TTask extends WorkItem = WorkItem>(
    options: DeliverChangeOptions<TTask>,
  ): Promise<DeliveryResult<TTask>> {
    validateLimit(options.limits.ciFixAttempts, "ciFixAttempts");
    validateLimit(options.limits.pullRequestRevisionRounds, "pullRequestRevisionRounds");
    const built = await implementAndReview(options);
    if (built.status !== "approved") return built;
    const pr = await publishApprovedChange({ ...options, change: built.change });
    return followPullRequest({ ...options, change: built.change, pr });
  }

  return { deliverChange, implementAndReview, publishApprovedChange, followPullRequest };
}
