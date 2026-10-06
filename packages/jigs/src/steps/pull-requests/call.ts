import { JigsError } from "../../errors.ts";
import { githubRequest } from "../../providers/github-api.ts";
import type { JsonValue } from "../../workflow/human/questions.ts";

/**
 * Call any GitHub REST endpoint as the factory's GitHub App, and return
 * GitHub's parsed JSON response. Wrap it in your own `"use step"` function.
 *
 * @remarks
 * `path` starts with `/` and is the endpoint's path with its query string, such as
 * `/repos/acme/app/commits?author=dev@acme.com`. `installationName` names the
 * App installation, as named on the hub, to call through. `body` is sent as
 * JSON. An answer with no content, such as 204, returns `undefined`.
 *
 * When GitHub answers with an error status, it throws a {@link GitHubApiError}
 * with the `status` and GitHub's message. Rate-limited calls are retried. A
 * step can run more than once, so a call that is not safe to repeat has to
 * accept what a repeat gets back. The App needs whatever permission the
 * endpoint asks for.
 *
 * @example
 * ```ts
 * // workflows/review/steps.ts
 * import { callGitHub } from "@jigs-ai/jigs/steps/pull-requests";
 *
 * export async function closeIssue(repo: string, issue: number) {
 *   "use step";
 *   await callGitHub("PATCH", `/repos/${repo}/issues/${issue}`, {
 *     installationName: "github-acme",
 *     body: { state: "closed" },
 *   });
 * }
 * ```
 *
 * @group Any REST endpoint
 */
export async function callGitHub<T = unknown>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  options: { installationName: string; body?: JsonValue },
): Promise<T> {
  if (!path.startsWith("/")) throw new JigsError(`GitHub path ${path} must start with /`);
  const response = await githubRequest<T>(options.installationName, method, path, options.body);
  console.log(`[github] called ${method} ${path.split("?")[0]}`);
  return response;
}
