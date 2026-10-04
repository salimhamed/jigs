// Every GitHub REST call jigs makes goes through here, so the credential is
// decided in exactly one place. GITHUB_API_URL override is a test seam.

import { JigsError } from "../errors.ts";
import { GITHUB_API_BASE, githubAuthFor, githubUsesPat } from "./github-auth.ts";

/**
 * GitHub answered a REST call with an error status. Check `status` to handle
 * one answer, such as 422 when GitHub refuses a request it understood.
 *
 * @group Errors
 */
export class GitHubApiError extends JigsError {
  /** The HTTP status, such as 404 or 422. */
  readonly status: number;
  /** GitHub's `message`, or the whole response body when it has none. */
  readonly githubMessage: string;
  /** The response body as GitHub sent it. */
  readonly body: string;

  constructor(status: number, apiPath: string, body: string) {
    super(`GitHub API ${status} on ${apiPath}: ${body}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.githubMessage = messageOf(body);
    this.body = body;
  }
}

function messageOf(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
      const { message } = parsed;
      if (typeof message === "string") return message;
    }
  } catch {}
  return body;
}

export async function githubRequest<T>(
  method: string,
  apiPath: string,
  body?: unknown,
  account?: string,
): Promise<T> {
  const owner = /^\/repos\/([^/?#]+)\/[^/?#]+(?:[/?]|$)/.exec(apiPath)?.[1];
  const target = owner ?? account;
  if (!target && apiPath !== "/user")
    throw new JigsError(`GitHub request ${apiPath} requires an account`);
  if (apiPath === "/user" && !githubUsesPat()) throw new JigsError("/user requires a PAT identity");
  const auth = githubAuthFor(target ?? "");
  const token = await auth.bearer();
  const res = await fetch(`${GITHUB_API_BASE()}${apiPath}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new GitHubApiError(res.status, apiPath, await res.text());
  }
  // 204 on a POST that adds nothing to say — assignees and labels do this.
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const githubGet = <T>(apiPath: string): Promise<T> => githubRequest<T>("GET", apiPath);

// GitHub caps a page at 100 and a short page is the last one. The ceiling is
// not a real pull request's size — it is the stop for a proxy that answers
// every page with a full one, which would otherwise spin a step forever.
const MAX_PAGES = 50;

export async function githubGetAll<T>(apiPath: string): Promise<T[]> {
  const join = apiPath.includes("?") ? "&" : "?";
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await githubGet<T[]>(`${apiPath}${join}per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  throw new Error(`GitHub kept returning full pages of ${apiPath} past ${MAX_PAGES} pages`);
}
