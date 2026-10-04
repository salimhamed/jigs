// Every GitHub REST call jigs makes goes through here, so the credential is
// decided in exactly one place.

import { JigsError } from "../errors.ts";
import { githubAuthFor, githubUsesPat } from "./github-auth.ts";
import { GitHubApiError, githubSend } from "./github-http.ts";

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
  return githubSend<T>({ auth: githubAuthFor(target ?? ""), method, apiPath, json: body });
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
  throw new GitHubApiError(
    200,
    apiPath,
    "",
    `GitHub kept returning full pages of ${apiPath} past ${MAX_PAGES} pages`,
  );
}
