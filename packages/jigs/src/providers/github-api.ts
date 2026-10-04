// Every GitHub REST call jigs makes goes through here, so the credential is
// decided in exactly one place.

import type { FactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import { githubAuthFor, githubUsesPat } from "./github-auth.ts";
import { GitHubApiError, githubSend } from "./github-http.ts";

export interface GithubRequestOptions {
  /** The account whose credential to use, for a path that names no repository owner. */
  account?: string;
  /** The factory whose credential to use. Defaults to the process's own. */
  context?: FactoryContext;
}

export async function githubRequest<T>(
  method: string,
  apiPath: string,
  body?: unknown,
  options: GithubRequestOptions = {},
): Promise<T> {
  const owner = /^\/repos\/([^/?#]+)\/[^/?#]+(?:[/?]|$)/.exec(apiPath)?.[1];
  const target = owner ?? options.account;
  if (!target && apiPath !== "/user")
    throw new JigsError(`GitHub request ${apiPath} requires an account`);
  if (apiPath === "/user" && !githubUsesPat(options.context))
    throw new JigsError("/user requires a PAT identity");
  return githubSend<T>({
    auth: githubAuthFor(target ?? "", options.context),
    method,
    apiPath,
    json: body,
  });
}

export const githubGet = <T>(apiPath: string, context?: FactoryContext): Promise<T> =>
  githubRequest<T>("GET", apiPath, undefined, { context });

// GitHub caps a page at 100 and a short page is the last one. The ceiling is
// not a real pull request's size — it is the stop for a proxy that answers
// every page with a full one, which would otherwise spin a step forever.
const MAX_PAGES = 50;

export async function githubGetAll<T>(apiPath: string, context?: FactoryContext): Promise<T[]> {
  const join = apiPath.includes("?") ? "&" : "?";
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await githubGet<T[]>(`${apiPath}${join}per_page=100&page=${page}`, context);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  throw new GitHubApiError(
    200,
    apiPath,
    "",
    `GitHub kept returning full pages of ${apiPath} past ${MAX_PAGES} pages`,
  );
}
