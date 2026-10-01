import { githubRequest } from "../../providers/github-api.ts";
import type { JsonValue } from "../../workflow/human/questions.ts";

/**
 * Call any GitHub REST endpoint as the factory's GitHub identity, and return
 * GitHub's parsed JSON response. Wrap it in your own `"use step"` function.
 *
 * @remarks
 * `path` is the endpoint's path with its query string, such as
 * `/repos/acme/app/commits?author=dev@acme.com`. A path under
 * `/repos/{owner}/{repo}` authenticates for that owner: with a GitHub App, the
 * installation configured for it. Any other path, such as `/orgs/acme/teams`,
 * needs `account` to say which owner's installation to use. `body` is sent as
 * JSON. An answer with no content, such as 204, returns `undefined`.
 *
 * When GitHub answers with an error status, it throws a {@link GitHubApiError}
 * with the `status` and GitHub's message. A step can run more than once, so a
 * call that is not safe to repeat has to accept what a repeat gets back. The
 * App needs whatever permission the endpoint asks for.
 *
 * @example
 * ```ts
 * // workflows/review/steps.ts
 * import { callGitHub } from "@jigs-ai/jigs/steps/pull-requests";
 *
 * export async function requestReviewers(repo: string, pr: number, reviewers: string[]) {
 *   "use step";
 *   await callGitHub("POST", `/repos/${repo}/pulls/${pr}/requested_reviewers`, {
 *     body: { reviewers },
 *   });
 * }
 * ```
 *
 * @group Any REST endpoint
 */
export async function callGitHub<T = unknown>(
  method: string,
  path: string,
  options: { body?: JsonValue; account?: string } = {},
): Promise<T> {
  const response = await githubRequest<T>(method, path, options.body, options.account);
  console.log(`[github] called ${method} ${path.split("?")[0]}`);
  return response;
}
