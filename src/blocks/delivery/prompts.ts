// The prompts jigs sends when a role supplies no callback of its own. They are
// exported so a role that only wants to add to one can render it directly,
// the same way `renderDefaultPrompt()` does from inside a prompt callback.

import { renderFindings, renderLedger, renderResponses } from "./review.ts";
import type {
  CiRepairPromptContext,
  DescriptionPromptContext,
  ImplementationPromptContext,
  PullRequestRevisionPromptContext,
  ReviewPromptContext,
  WorkItem,
} from "./types.ts";

function taskBrief(task: WorkItem): string[] {
  return [`Task ${task.key}: ${task.title}`, task.url ?? "", task.instructions];
}

function prompt(parts: string[], job: string): string {
  return [...parts, job].filter(Boolean).join("\n\n");
}

export const defaultImplementationPrompt = async (
  context: ImplementationPromptContext,
): Promise<string> => {
  const diff = await context.readDiff?.();
  return prompt(
    [
      ...taskBrief(context.task),
      `Base commit: ${context.worktree.baseSha}`,
      context.instructions,
      context.findings.length ? `Findings:\n${renderFindings(context.findings)}` : "",
      diff === undefined ? "" : `Current diff:\n${diff}`,
    ],
    "Implement the requirements and address the findings. Follow the repository instructions, run relevant checks, and commit your changes before you finish: only committed work is reviewed, and an uncommitted worktree stops the change. Do not push or open a pull request.\n\nAnswer every finding you were given, one response each, quoting the finding as it was stated. Set changed to true with what you changed, or to false with the reason you did not — a finding you decline stays open until the reviewer accepts your reason, so give one it can judge. Return no responses on a round that was given no findings.",
  );
};

const reviewJob = [
  "Review the changes against the requirements and repository instructions. Inspect the diff between the base and head commits and check for correctness and regressions. Do not edit files.",
  "Separate blocking findings — a stated requirement left unmet, a defect a user could hit, or an untested risk that matters — from non-blocking preferences about naming, structure, comments, extra test cases and wording. Mark each finding blocking or not. Return changes-requested only when a blocking finding remains; otherwise return approved and keep the non-blocking observations in findings, where a human reads them on the pull request.",
  "You have already reviewed the earlier rounds of this change. Do not re-open a finding you cleared unless the code under it changed. Where the builder answered a finding with a reason for not changing it, either accept that reason and drop the finding, or re-raise it as blocking with one sentence saying why the reason does not hold.",
].join("\n\n");

export const defaultReviewPrompt = (context: ReviewPromptContext): string =>
  prompt(
    [
      ...taskBrief(context.task),
      `Base commit: ${context.baseCommit}`,
      `Head commit under review: ${context.headCommit}`,
      `Review round: ${context.attempt}`,
      context.instructions,
      context.ledger === undefined || context.ledger.length === 0
        ? ""
        : `Earlier rounds of this review:\n${renderLedger(context.ledger)}`,
      context.responses.length === 0
        ? ""
        : `The builder's answer to each finding you last raised:\n${renderResponses(context.responses)}`,
      `Current diff:\n${context.diff}`,
    ],
    reviewJob,
  );

export const defaultCiRepairPrompt = async (context: CiRepairPromptContext): Promise<string> => {
  const diff = await context.readDiff?.();
  return prompt(
    [
      ...taskBrief(context.task),
      `Base commit: ${context.worktree.baseSha}`,
      context.instructions,
      diff === undefined ? "" : `Current diff:\n${diff}`,
      `Failing checks:\n${JSON.stringify(context.failing)}`,
    ],
    "Investigate the failing checks, fix their cause, run relevant checks, and commit the fix. Do not push.",
  );
};

export const defaultRevisionPrompt = async (
  context: PullRequestRevisionPromptContext,
): Promise<string> => {
  const diff = await context.readDiff?.();
  return prompt(
    [
      ...taskBrief(context.task),
      `Base commit: ${context.worktree.baseSha}`,
      context.instructions,
      diff === undefined ? "" : `Current diff:\n${diff}`,
      `Review threads:\n${JSON.stringify(context.threads)}`,
      context.reviewBody ?? "Address the pull request review threads.",
    ],
    "Address the review feedback, test and commit any changes, and explain your response to each thread. Use its rootId as threadId; every thread listed has one, the review summary included. Set commitExplanation to a concise account of changes and validation when you commit, or null when you do not. Do not push or post comments yourself.",
  );
};

export const defaultDescriptionPrompt = (context: DescriptionPromptContext): string =>
  prompt(
    [
      ...taskBrief(context.task),
      `Base commit: ${context.worktree.baseSha}`,
      `Current diff:\n${context.diff}`,
    ],
    "Write a concise pull request title and body explaining the change and its validation. Include the task link when available. Follow the repository's pull request conventions. Do not modify files.",
  );
