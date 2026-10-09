// Route the process's GitHub or Slack calls to a client built on test fakes,
// restored by `vi.restoreAllMocks()`.

import { slackBotScopes } from "@jigs-ai/hub-protocol";
import { type Mock, vi } from "vitest";
import type { FactoryContext } from "../config/factory-context.ts";
import { testFactoryContext } from "../test-fixtures.ts";
import { createGithubClient, type GithubClientDeps, githubClient } from "./github-http.ts";
import * as hub from "./hub.ts";
import { createPagerDutyClient, PAGERDUTY_API_URL, type PagerDutyIncident } from "./pagerduty.ts";
import * as slack from "./slack.ts";
import { createSlackClient, type SlackClientDeps } from "./slack.ts";
import { type FetchCall, fakeFetch } from "./test-support.ts";

type TokenAnswer<P extends keyof hub.HubTokenResponses> = (
  installationName: string,
  ctx?: FactoryContext,
) => Promise<hub.HubTokenResponses[P]>;

const hubTokenAnswers = new Map<string, TokenAnswer<never>>();

/**
 * Answer the hub's `provider` token requests with the returned mock, keeping the answers this test
 * already gives for the other providers.
 */
export function answerHubTokens<P extends keyof hub.HubTokenResponses>(
  provider: P,
  answer: TokenAnswer<P>,
): Mock<TokenAnswer<P>> {
  if (!vi.isMockFunction(hub.hubToken)) {
    hubTokenAnswers.clear();
    vi.spyOn(hub, "hubToken").mockImplementation((async (asked, installationName, ctx) => {
      const answered = hubTokenAnswers.get(asked);
      if (answered === undefined) throw new Error(`this test answers no ${asked} token request`);
      return answered(installationName, ctx);
    }) as typeof hub.hubToken);
  }
  const mock = vi.fn(answer);
  hubTokenAnswers.set(provider, mock as unknown as TokenAnswer<never>);
  return mock;
}

/** The installation token and bot every faked GitHub call gets from the hub. */
export const TEST_GITHUB_TOKEN = "ghs_test";
export const TEST_APP_BOT = { login: "jigs-test[bot]", id: 4242 };

/** Answer every GitHub token request with {@link TEST_GITHUB_TOKEN}, as the hub would. */
export function useHubGithubTokens(): void {
  answerHubTokens("github", async () => ({
    token: TEST_GITHUB_TOKEN,
    expiresAt: "2999-01-01T00:00:00Z",
    account: "acme",
    app: { slug: "jigs-test", botUserId: TEST_APP_BOT.id },
  }));
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
  return answerHubTokens("slack", async () => ({
    token: TEST_SLACK_TOKEN,
    app: TEST_SLACK_BOT,
    team: "T0TEST",
    scopes: [...scopes],
  }));
}

/**
 * Build every Slack client the code under test asks for on `deps`, for whichever installation it
 * names; returns the hub's Slack token answer.
 */
export function useSlackClient(deps: Omit<SlackClientDeps, "installationName">) {
  const tokens = useHubSlackTokens();
  vi.spyOn(slack, "slackFor").mockImplementation((installationName, context) =>
    createSlackClient({ ...deps, installationName, ...(context === undefined ? {} : { context }) }),
  );
  return tokens;
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
  answerHubTokens("slack", async () => ({
    token,
    app: { appId: auth.app_id ?? "A0LIVE", name: auth.user, botUserId: auth.user_id },
    team: auth.team_id,
    scopes,
  }));
}

/**
 * A PagerDuty client for the live tests, sending `JIGS_TEST_PAGERDUTY_TOKEN` (a PagerDuty app's
 * OAuth token, from the shell) as the hub would hand it out, and writing as `from`.
 */
export function livePagerDutyClient(token: string, from: string) {
  return createPagerDutyClient({
    installationName: "pagerduty-live",
    tokens: { issued: async () => ({ token, from }), invalidate: () => {} },
    context: testFactoryContext(),
  });
}

/** The incident a live test opened under `dedupKey`, once PagerDuty lists it. */
export async function waitForLiveIncident(
  token: string,
  dedupKey: string,
): Promise<PagerDutyIncident> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const res = await fetch(
      `${PAGERDUTY_API_URL}/incidents?incident_key=${encodeURIComponent(dedupKey)}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.pagerduty+json;version=2",
        },
      },
    );
    if (!res.ok) throw new Error(`PagerDuty answered ${res.status} listing incidents`);
    const [incident] = ((await res.json()) as { incidents: PagerDutyIncident[] }).incidents;
    if (incident !== undefined) return incident;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("the test incident never appeared");
}
