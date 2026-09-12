import type { DeliveryPromptContext } from "./types.ts";

export function contextPrompt(context: DeliveryPromptContext): string {
  return [
    `Task ${context.task.key}: ${context.task.title}`,
    context.task.url ?? "",
    context.task.instructions,
    `Base commit: ${context.worktree.baseSha}`,
    context.headSha === undefined ? "" : `Head commit under review: ${context.headSha}`,
    context.instructions,
    context.findings.length ? `Findings:\n${context.findings.join("\n")}` : "",
    context.diff === undefined ? "" : `Current diff:\n${context.diff}`,
    context.failing === undefined ? "" : `Failing checks:\n${JSON.stringify(context.failing)}`,
    context.threads === undefined ? "" : `Review threads:\n${JSON.stringify(context.threads)}`,
    context.reviewBody ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const implementPrompt = (context: DeliveryPromptContext): string =>
  `${contextPrompt(context)}\n\nImplement the requirements and address the findings. Follow the repository instructions, run relevant checks, and commit your changes before you finish: only committed work is reviewed, and an uncommitted worktree stops the change. Do not push or open a pull request.`;

export const reviewPrompt = (context: DeliveryPromptContext): string =>
  `${contextPrompt(context)}\n\nReview the changes against the requirements and repository instructions. Inspect the diff between the base and head commits and check for correctness and regressions. Do not edit files. Return approved only when no changes are needed; otherwise return changes-requested with actionable findings.`;

export const repairPrompt = (context: DeliveryPromptContext): string =>
  `${contextPrompt(context)}\n\nInvestigate the failing checks, fix their cause, run relevant checks, and commit the fix. Do not push.`;

export const revisionPrompt = (context: DeliveryPromptContext): string =>
  `${contextPrompt(context)}\n\nAddress the review feedback, test and commit any changes, and explain your response to each thread. Use its rootId as threadId, or null for the review summary. Do not push or post comments yourself.`;

export const descriptionPrompt = (context: DeliveryPromptContext): string =>
  `${contextPrompt(context)}\n\nWrite a concise pull request title and body explaining the change and its validation. Include the task link when available. Follow the repository's pull request conventions. Do not modify files.`;
