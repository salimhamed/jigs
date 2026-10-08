// GitHub's request loop: its headers, its failure and its rate-limit
// signals. Credential minting sends through here too, so it cannot
// live beside the per-account credential choice in github-api.ts.

import { runSignal } from "../config/factory-context.ts";
import { ProviderApiError, type ProviderAuth, rateLimitWaits, reauthorize } from "./http.ts";

const GITHUB_API_URL = "https://api.github.com";

// GitHub's advice for a secondary limit that names no wait.
const UNNAMED_RATE_LIMIT_WAIT_SECONDS = 60;
const SERVER_ERROR_WAIT_SECONDS = 5;

/**
 * GitHub answered a REST call with an error status. Check `status` to handle
 * one answer, such as 422 when GitHub refuses a request it understood.
 *
 * @group Errors
 */
export class GitHubApiError extends ProviderApiError {
  /** The HTTP status, such as 404 or 422. */
  declare readonly status: number;
  /** GitHub's `message`, or the whole response body when it has none. */
  readonly githubMessage: string;
  /** The response body as GitHub sent it. */
  declare readonly body: string;

  constructor(status: number, apiPath: string, body: string, message?: string) {
    super({
      provider: "github",
      status,
      request: apiPath,
      body,
      message: message ?? `GitHub API ${status} on ${apiPath}: ${body}`,
    });
    this.name = "GitHubApiError";
    this.githubMessage = messageOf(body);
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

// A primary limit is a 429, or a 403 with no requests left; a secondary one is
// a 403 that names its wait.
function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  return (
    res.status === 403 &&
    (res.headers.has("retry-after") || res.headers.get("x-ratelimit-remaining") === "0")
  );
}

function rateLimitSeconds(res: Response): number {
  const after = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
  if (!Number.isNaN(after)) return after;
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (res.headers.get("x-ratelimit-remaining") === "0" && reset > 0) {
    return Math.max(1, Math.ceil(reset - Date.now() / 1000));
  }
  return UNNAMED_RATE_LIMIT_WAIT_SECONDS;
}

export interface GithubSend {
  auth: ProviderAuth;
  method?: string;
  /** The path under the API root, with its query. */
  apiPath: string;
  json?: unknown;
  /** Turns an error answer into the failure; defaults to a {@link GitHubApiError}. */
  refuse?: (res: Response, text: string) => Error;
  /**
   * Keeps a rate-limit wait going when the calling run is cancelled, for work shared between runs
   * such as a token mint.
   */
  outlivesRun?: true;
}

export interface GithubClientDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function createGithubClient(deps: GithubClientDeps = {}) {
  async function send<T>({
    auth,
    method = "GET",
    apiPath,
    json,
    refuse,
    outlivesRun,
  }: GithubSend): Promise<T> {
    let reauthorized = false;
    const waits = rateLimitWaits("github", outlivesRun ? null : runSignal, deps.sleep);
    for (;;) {
      const credential = await auth.bearer();
      const res = await (deps.fetch ?? fetch)(`${GITHUB_API_URL}${apiPath}`, {
        method,
        headers: {
          authorization: `Bearer ${credential}`,
          ...(json === undefined ? {} : { "content-type": "application/json" }),
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
        body: json === undefined ? undefined : JSON.stringify(json),
      });
      const text = await res.text();
      if (res.status === 401 && !reauthorized && reauthorize(auth, credential)) {
        reauthorized = true;
        continue;
      }
      if (isRateLimited(res) && (await waits.wait(rateLimitSeconds(res)))) continue;
      // Only a read is sent again: a write GitHub failed on may still have landed.
      if (
        method === "GET" &&
        res.status >= 500 &&
        (await waits.wait(SERVER_ERROR_WAIT_SECONDS, "server error"))
      )
        continue;
      if (!res.ok) throw refuse?.(res, text) ?? new GitHubApiError(res.status, apiPath, text);
      // 204 on a POST that adds nothing to say — assignees and labels do this.
      return (res.status === 204 || text === "" ? undefined : JSON.parse(text)) as T;
    }
  }
  return { send };
}

export type GithubClient = ReturnType<typeof createGithubClient>;

/** The process's GitHub client. `githubSend` calls it, so a test can spy on `send`. */
export const githubClient: GithubClient = createGithubClient();

export function githubSend<T>(spec: GithubSend): Promise<T> {
  return githubClient.send<T>(spec);
}
