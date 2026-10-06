// The Linear issue calls a factory wraps as its own steps, each through the
// Linear installation it names.

import {
  type CreateIssueInProjectInput,
  type LinearIssueMatch,
  linearFor,
} from "../../providers/linear.ts";

export type { CreateIssueInProjectInput, LinearIssueMatch };

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
 * Create a ticket in the project’s first team.
 *
 * @group Create and update
 */
export function createIssueInProject({
  installationName,
  ...input
}: CreateIssueInProjectInput & { installationName: string }): Promise<{
  id: string;
  identifier: string;
  url: string;
}> {
  return linearFor(installationName).createIssueInProject(input);
}

/**
 * Find the newest ticket in a project whose title starts with the given text.
 *
 * @group Resolve and read
 */
export function findIssueInProject({
  installationName,
  ...input
}: {
  installationName: string;
  project: string;
  titlePrefix: string;
}): Promise<LinearIssueMatch | null> {
  return linearFor(installationName).findIssueInProject(input);
}
