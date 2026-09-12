import type { z } from "zod";
import { resumeOrRebuild } from "../agent/resume-or-rebuild.ts";
import { threadAnswers } from "../builder-agent/answer-review.ts";
import { pullRequestDescription } from "../builder-agent/describe-pr.ts";
import { codeReviewVerdict } from "../builder-agent/implement.ts";
import { postReviewAnswers } from "../pull-request/answers.ts";
import { attend, finished, listen } from "../pull-request/attend.ts";
import {
  descriptionPrompt,
  implementPrompt,
  repairPrompt,
  reviewPrompt,
  revisionPrompt,
} from "./prompts.ts";
import type {
  AgentRoleName,
  DeliveryAgent,
  DeliveryChange,
  DeliveryLimit,
  DeliveryPromptContext,
  DeliveryResult,
  DeliverySteps,
  DeliveryStopped,
  FollowPullRequestOptions,
  ImplementOptions,
  ImplementResult,
  OnDeliveryLimit,
  OpenPullRequestOptions,
  ReviewLoopOptions,
} from "./types.ts";

function validateLimit(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
}

async function extendLimit(limit: DeliveryLimit, onLimit?: OnDeliveryLimit) {
  if (onLimit === undefined) return { status: "limit-reached" as const };
  const decision = await onLimit(limit);
  if (decision.action === "stop") return { status: "stopped" as const };
  validateLimit(decision.additionalAttempts, "additionalAttempts", 1);
  return { additionalAttempts: decision.additionalAttempts, instructions: decision.instructions };
}

function stopped(
  change: DeliveryChange,
  limit: DeliveryLimit,
  status: DeliveryStopped["status"],
): DeliveryStopped {
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
    agent,
    pullRequestGate,
    readBranchState,
    readWorktreeDiff,
    pushBranch,
    resolveRepository,
    createPullRequest,
    commentOnPullRequest,
    replyToPullRequestReviewThread,
    squashMergePullRequest,
  } = steps;

  async function runRole<T = undefined>(
    change: DeliveryChange,
    name: AgentRoleName,
    role: DeliveryAgent,
    context: DeliveryPromptContext,
    defaultPrompt: (context: DeliveryPromptContext) => string,
    output?: z.ZodType<T>,
  ) {
    const saved = change.sessions[name];
    const session =
      saved !== undefined && JSON.stringify(saved.harness) === JSON.stringify(role.harness)
        ? saved.session
        : undefined;
    const prompt = (role.prompt ?? defaultPrompt)(context);
    const result = await resumeOrRebuild({
      agent,
      harness: role.harness,
      cwd: change.worktree.path,
      ...(session === undefined ? {} : { session }),
      resumePrompt: prompt,
      freshPrompt: async () =>
        (role.prompt ?? defaultPrompt)({
          ...context,
          diff: await readWorktreeDiff(change.worktree.path, change.worktree.baseSha),
        }),
      ...(output === undefined ? {} : { output }),
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
  async function implementAndReview(options: ImplementOptions): Promise<ImplementResult> {
    validateLimit(options.maxRounds, "maxRounds");
    const change: DeliveryChange = {
      task: options.task,
      worktree: options.worktree,
      attempts: { implementationReviewRounds: 0, ciFixAttempts: 0, pullRequestRevisionRounds: 0 },
      sessions: {},
    };
    let budget = options.maxRounds;
    let findings: string[] = [];
    let instructions = "";
    for (;;) {
      if (change.attempts.implementationReviewRounds >= budget) {
        const limit: DeliveryLimit = {
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
      const context: DeliveryPromptContext = {
        task: change.task,
        worktree: change.worktree,
        phase: "implementation-review",
        attempt: change.attempts.implementationReviewRounds,
        findings,
        instructions,
      };
      await runRole(change, "implementation", options.implementation, context, implementPrompt);
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
      const verdict = await agent({
        harness: options.review.harness,
        cwd: change.worktree.path,
        prompt: (options.review.prompt ?? reviewPrompt)({ ...context, headSha: state.headSha }),
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
  async function openPullRequest(options: OpenPullRequestOptions) {
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
    const context: DeliveryPromptContext = {
      task: change.task,
      worktree: change.worktree,
      phase: "pull-request-description",
      attempt: 1,
      findings: [],
      instructions: "",
      diff: await readWorktreeDiff(path, baseSha),
    };
    const result = await agent({
      harness: role.harness,
      cwd: path,
      prompt: (role.prompt ?? descriptionPrompt)(context),
      output: pullRequestDescription,
    });
    const description = pullRequestDescription.parse(
      role.transform?.(result.output, change.task) ?? result.output,
    );
    const repository = await resolveRepository(options.binding);
    return createPullRequest(
      repository,
      branch,
      defaultBranch,
      description.title,
      description.body,
    );
  }

  /** Address CI and review feedback until merge, closure, or an exhausted attempt budget. */
  async function followPullRequest(options: FollowPullRequestOptions): Promise<DeliveryResult> {
    validateLimit(options.limits.ciFixAttempts, "ciFixAttempts");
    validateLimit(options.limits.pullRequestRevisionRounds, "pullRequestRevisionRounds");
    const { change, pr } = options;
    const budgets = { ...options.limits };
    const instructions = { ciFixAttempts: "", pullRequestRevisionRounds: "" };
    const seenRed = new Set<string>();
    const seenReviews = new Set<number>();
    const seenComments = new Set<number>();
    return attend<DeliveryResult>(pullRequestGate(pr), async (wake) => {
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
        const limit: DeliveryLimit = {
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
      const context: DeliveryPromptContext = {
        task: change.task,
        worktree: change.worktree,
        phase,
        attempt: change.attempts[counter],
        findings,
        instructions: instructions[counter],
        ...(wake.kind === "ci-red"
          ? { failing: wake.failing }
          : {
              threads: wake.kind === "review-comments" ? wake.threads : [],
              ...(wake.body === undefined ? {} : { reviewBody: wake.body }),
            }),
      };
      if (ci) {
        await runRole(
          change,
          "ciRepair",
          options.ciRepair ?? { harness: options.implementation.harness },
          context,
          repairPrompt,
        );
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
      const answers = await runRole(
        change,
        "pullRequestRevision",
        options.pullRequestRevision ?? { harness: options.implementation.harness },
        context,
        revisionPrompt,
        threadAnswers,
      );
      const state = await readBranchState(change.worktree.path, change.worktree.baseSha);
      if (state.dirty) throw new Error("Pull request revision left uncommitted changes");
      await pushBranch(change.worktree.path, change.worktree.branch);
      const ids = await postReviewAnswers({
        commentOnPullRequest,
        replyToPullRequestReviewThread,
        pr,
        answers,
        threads: context.threads ?? [],
      });
      return listen({ selfCommentIds: ids });
    });
  }

  /** Deliver a work item using configurable agents, review budgets, and merge policy. */
  async function reviewLoop(options: ReviewLoopOptions): Promise<DeliveryResult> {
    validateLimit(options.limits.ciFixAttempts, "ciFixAttempts");
    validateLimit(options.limits.pullRequestRevisionRounds, "pullRequestRevisionRounds");
    const built = await implementAndReview({
      ...options,
      maxRounds: options.limits.implementationReviewRounds,
    });
    if (built.status !== "approved") return built;
    const pr = await openPullRequest({ ...options, change: built.change });
    return followPullRequest({ ...options, change: built.change, pr });
  }

  return { reviewLoop, implementAndReview, openPullRequest, followPullRequest };
}
