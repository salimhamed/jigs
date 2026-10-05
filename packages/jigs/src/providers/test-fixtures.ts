// Route the process's GitHub or Slack calls to a client built on test fakes,
// restored by `vi.restoreAllMocks()`.

import { slackBotScopes } from "@jigs-ai/hub-protocol";
import { vi } from "vitest";
import { createGithubClient, type GithubClientDeps, githubClient } from "./github-http.ts";
import * as hub from "./hub.ts";
import { createSlackClient, type SlackClientDeps, slackClient } from "./slack.ts";
import { type FetchCall, fakeFetch } from "./test-support.ts";

/** The installation token and bot every faked GitHub call gets from the hub. */
export const TEST_GITHUB_TOKEN = "ghs_test";
export const TEST_APP_BOT = { login: "jigs-test[bot]", id: 4242 };

/** Answer every GitHub token request with {@link TEST_GITHUB_TOKEN}, as the hub would. */
export function useHubGithubTokens(): void {
  vi.spyOn(hub, "fetchGithubToken").mockResolvedValue({
    token: TEST_GITHUB_TOKEN,
    expiresAt: "2999-01-01T00:00:00Z",
    app: { slug: "jigs-test", botUserId: TEST_APP_BOT.id },
  });
}

export function useGithubClient(deps: GithubClientDeps): void {
  const client = createGithubClient(deps);
  vi.spyOn(githubClient, "send").mockImplementation(client.send);
  useHubGithubTokens();
}

/** The bot token and bot every faked Slack call gets from the hub. */
export const TEST_SLACK_TOKEN = "xoxb-test";
export const TEST_SLACK_BOT = { appId: "A0TEST", name: "jigs-test", botUserId: "U0C59SU5V29" };

/** Answer every Slack token request with {@link TEST_SLACK_TOKEN}, as the hub would. */
export function useHubSlackTokens(scopes: readonly string[] = slackBotScopes) {
  return vi.spyOn(hub, "fetchSlackToken").mockResolvedValue({
    token: TEST_SLACK_TOKEN,
    app: TEST_SLACK_BOT,
    team: "T0TEST",
    scopes: [...scopes],
  });
}

export function useSlackClient(deps: SlackClientDeps): void {
  useHubSlackTokens();
  const client = createSlackClient(deps);
  for (const key of Object.keys(client) as Array<keyof typeof client>) {
    vi.spyOn(slackClient, key).mockImplementation(client[key] as never);
  }
}

export interface FakeGithub {
  calls: FetchCall[];
  /** Queue the answer to the next unanswered call; an error is thrown as a network failure. */
  reply(res: Response | Error): FakeGithub;
}

/** Route this process's GitHub calls to a fake that answers each with the next queued reply. */
export function fakeGithub(deps: Pick<GithubClientDeps, "sleep"> = {}): FakeGithub {
  const replies: Array<Response | Error> = [];
  const { fetch, calls } = fakeFetch((call) => {
    const reply =
      replies.shift() ?? new Response(`no reply queued for ${call.url.pathname}`, { status: 599 });
    if (reply instanceof Error) throw reply;
    return reply;
  });
  useGithubClient({ ...deps, fetch });
  const github: FakeGithub = {
    calls,
    reply(res) {
      replies.push(res);
      return github;
    },
  };
  return github;
}

/**
 * Hand the live tests' `JIGS_TEST_SLACK_BOT_TOKEN` (a test app's, from the shell) out as the hub would,
 * with the bot and scopes Slack reports for it.
 */
export async function useLiveSlackToken(token: string): Promise<void> {
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const auth = (await res.json()) as {
    user_id: string;
    user: string;
    team_id: string;
    app_id?: string;
  };
  const scopes = (res.headers.get("x-oauth-scopes") ?? "").split(",").filter(Boolean);
  vi.spyOn(hub, "fetchSlackToken").mockResolvedValue({
    token,
    app: { appId: auth.app_id ?? "A0LIVE", name: auth.user, botUserId: auth.user_id },
    team: auth.team_id,
    scopes,
  });
}
