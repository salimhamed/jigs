// The prompts jigs sends when a role supplies no callback of its own. They are
// exported so a role that only wants to add to one can render it directly,
// the same way `renderDefaultPrompt()` does from inside a prompt callback.

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
      context.findings.length ? `Findings:\n${context.findings.join("\n")}` : "",
      diff === undefined ? "" : `Current diff:\n${diff}`,
    ],
    "Implement the requirements and address the findings. Follow the repository instructions, run relevant checks, and commit your changes before you finish: only committed work is reviewed, and an uncommitted worktree stops the change. Do not push or open a pull request.",
  );
};

export const defaultReviewPrompt = (context: ReviewPromptContext): string =>
  prompt(
    [
      ...taskBrief(context.task),
      `Base commit: ${context.baseCommit}`,
      `Head commit under review: ${context.headCommit}`,
      context.instructions,
      `Current diff:\n${context.diff}`,
    ],
    "Review the changes against the requirements and repository instructions. Inspect the diff between the base and head commits and check for correctness and regressions. Do not edit files. Return approved only when no changes are needed; otherwise return changes-requested with actionable findings.",
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
    "Address the review feedback, test and commit any changes, and explain your response to each thread. Use its rootId as threadId, or null for the review summary. Do not push or post comments yourself.",
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
