// Every GitHub REST call jigs makes goes through here, so the credential is
// decided in exactly one place.

import type { FactoryContext } from "../config/factory-context.ts";
import { githubAuthFor } from "./github-auth.ts";
import { GitHubApiError, githubSend } from "./github-http.ts";

/** One REST or GraphQL call as the factory's App on the installation named `installationName`. */
export function githubRequest<T>(
  installationName: string,
  method: string,
  apiPath: string,
  body?: unknown,
  context?: FactoryContext,
): Promise<T> {
  return githubSend<T>({
    auth: githubAuthFor(installationName, context),
    method,
    apiPath,
    json: body,
  });
}

export const githubGet = <T>(
  installationName: string,
  apiPath: string,
  context?: FactoryContext,
): Promise<T> => githubRequest<T>(installationName, "GET", apiPath, undefined, context);

// GitHub caps a page at 100 and a short page is the last one. The ceiling is
// not a real pull request's size — it is the stop for a proxy that answers
// every page with a full one, which would otherwise spin a step forever.
const MAX_PAGES = 50;

export async function githubGetAll<T>(
  installationName: string,
  apiPath: string,
  context?: FactoryContext,
): Promise<T[]> {
  const join = apiPath.includes("?") ? "&" : "?";
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await githubGet<T[]>(
      installationName,
      `${apiPath}${join}per_page=100&page=${page}`,
      context,
    );
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
