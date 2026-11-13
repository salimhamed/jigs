// The Linear issue calls a factory wraps as its own steps, each through the
// Linear installation it names.

import {
  type CreateIssueInput,
  type FindIssueInput,
  type LinearIssueMatch,
  linearFor,
} from "../../providers/linear.ts";

export type { CreateIssueInput, FindIssueInput, LinearIssueMatch };

/**
 * Post a comment on a ticket. An `id` (UUID v4) names the comment in advance, so a caller can
 * find it again after a lost response instead of posting twice.
 *
 * @group Create and update
 */
export function createComment({
  installationName,
  issueId,
  body,
  id,
}: {
  installationName: string;
  issueId: string;
  body: string;
  id?: string;
}): Promise<{ id: string; createdAt: string }> {
  return linearFor(installationName).createComment(issueId, body, id);
}

/**
 * Create a ticket in a team, a project or both, optionally with a status and labels.
 *
 * @example
 * ```ts
 * // workflows/session-quality/steps.ts
 * import { createIssue, findIssue } from "@jigs-ai/jigs/steps/linear";
 *
 * export async function fileFinding(title: string, description: string) {
 *   "use step";
 *   const installationName = "linear-acme";
 *   const existing = await findIssue({ installationName, team: "ENG", titlePrefix: title });
 *   if (existing !== null) return existing;
 *   return createIssue({
 *     installationName,
 *     team: "ENG",
 *     status: "Triage",
 *     labels: ["Bug"],
 *     title,
 *     description,
 *   });
 * }
 * ```
 *
 * @group Create and update
 */
export function createIssue({
  installationName,
  ...input
}: CreateIssueInput & { installationName: string }): Promise<{
  id: string;
  identifier: string;
  url: string;
}> {
  return linearFor(installationName).createIssue(input);
}

/**
 * Find the newest ticket in a team or project whose title starts with the given text.
 *
 * @group Resolve and read
 */
export function findIssue({
  installationName,
  ...input
}: FindIssueInput & { installationName: string }): Promise<LinearIssueMatch | null> {
  return linearFor(installationName).findIssue(input);
}
