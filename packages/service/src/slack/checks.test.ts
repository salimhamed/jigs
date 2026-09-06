import { WebAPIPlatformError } from "@slack/web-api";
import type { SlackConfig } from "jigs";
import { expect, test } from "vitest";
import { type SlackProbes, slackChecks } from "./checks";

const SLACK: SlackConfig = {
  channel: "C0RUNS",
  allowed_users: ["U0ALLOWED"],
  model: "anthropic/claude-sonnet-4.5",
};

const BOTH_TOKENS = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
} as NodeJS.ProcessEnv;

const happy: SlackProbes = {
  authTest: async () => ({ ok: true }),
  conversationsInfo: async () => ({ ok: true }),
};

const platformError = (error: string, needed?: string) =>
  new WebAPIPlatformError({
    ok: false,
    error,
    ...(needed ? { needed } : {}),
  } as {
    ok: boolean;
    error: string;
  });

async function check(
  id: string,
  options: {
    slack?: SlackConfig | null;
    env?: NodeJS.ProcessEnv;
    probes?: Partial<SlackProbes>;
  } = {},
) {
  const checks = slackChecks({
    slack: () => (options.slack === undefined ? SLACK : options.slack),
    env: options.env ?? BOTH_TOKENS,
    probes: { ...happy, ...options.probes },
  });
  const found = checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no ${id} check`);
  return { label: found.label, ...(await found.run()) };
}

test("a factory with no slack block has no Slack checks at all", () => {
  expect(slackChecks({ slack: () => null, env: {}, probes: happy })).toEqual(
    [],
  );
});

test("an unreadable factory config leaves the reporting to the binding checks", () => {
  const checks = slackChecks({
    slack: () => {
      throw new Error("invalid jigs.yml");
    },
  });
  expect(checks).toEqual([]);
});

test("a declared block checks both tokens and the channel", async () => {
  const ids = slackChecks({
    slack: () => SLACK,
    env: BOTH_TOKENS,
    probes: happy,
  }).map((c) => c.id);
  expect(ids).toEqual(["slack.bot-token", "slack.app-token", "slack.channel"]);
});

test("both tokens pass when they are set and Slack accepts the bot token", async () => {
  expect(await check("slack.bot-token")).toMatchObject({ ok: true });
  expect(await check("slack.app-token")).toMatchObject({ ok: true });
  expect(await check("slack.channel")).toMatchObject({ ok: true });
});

test("an unset token names itself and points at the factory's .env", async () => {
  const tokens: [string, string][] = [
    ["slack.bot-token", "SLACK_BOT_TOKEN"],
    ["slack.app-token", "SLACK_APP_TOKEN"],
  ];
  for (const [id, variable] of tokens) {
    const result = await check(id, { env: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(`${variable} is not set`);
    expect(result.repair).toContain("the factory repo's .env");
    expect(result.repair).toContain("jigs service restart");
  }
});

test("the channel check cannot run without the bot token, and says so", async () => {
  const result = await check("slack.channel", {
    env: { SLACK_APP_TOKEN: "xapp-test" } as NodeJS.ProcessEnv,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain("SLACK_BOT_TOKEN is not set");
});

test("a channel the bot cannot see is repaired by an invite, not a new token", async () => {
  const result = await check("slack.channel", {
    probes: {
      conversationsInfo: () =>
        Promise.reject(platformError("channel_not_found")),
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe(
    "Slack conversations.info on C0RUNS answered channel_not_found",
  );
  expect(result.repair).toContain("invite it there");
  expect(result.repair).toContain("C0RUNS");
});

test("a missing scope reports the scope Slack asked for", async () => {
  const result = await check("slack.channel", {
    probes: {
      conversationsInfo: () =>
        Promise.reject(platformError("missing_scope", "channels:read")),
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain("missing_scope (needs channels:read)");
  expect(result.repair).toContain("jigs slack manifest");
});

test("a rejected bot token is repaired by reinstalling the app", async () => {
  const result = await check("slack.bot-token", {
    probes: { authTest: () => Promise.reject(platformError("invalid_auth")) },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("Slack auth.test answered invalid_auth");
  expect(result.repair).toContain("Bot User OAuth Token");
});

test("a failure Slack did not name still carries a repair to try", async () => {
  const result = await check("slack.bot-token", {
    probes: { authTest: () => Promise.reject(new Error("fetch failed")) },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("Slack auth.test failed: fetch failed");
  expect(result.repair).toContain("jigs slack manifest");
});
