import { WebAPIPlatformError } from "@slack/web-api";
import type { SlackConfig } from "jigs";
import { expect, test } from "vitest";
import { type SlackProbes, slackChecks } from "./checks";

const SLACK: SlackConfig = {
  channel: "C0RUNS",
  allowed_users: ["U0ALLOWED"],
};

const BOTH_TOKENS = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
} as NodeJS.ProcessEnv;

const happy: SlackProbes = {
  authTest: async () => ({ ok: true }),
  conversationsInfo: async () => ({
    channel: { is_member: true, is_archived: false },
  }),
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

test("a declared block checks both tokens and the channel", () => {
  const ids = slackChecks({
    slack: () => SLACK,
    env: BOTH_TOKENS,
    probes: happy,
  }).map((c) => c.id);
  expect(ids).toEqual(["slack.bot-token", "slack.app-token", "slack.channel"]);
});

test("everything passes when both tokens are the right kind and the bot is in the channel", async () => {
  expect(await check("slack.bot-token")).toMatchObject({ ok: true });
  expect(await check("slack.app-token")).toMatchObject({ ok: true });
  expect(await check("slack.channel")).toMatchObject({ ok: true });
});

test("the two tokens pasted the wrong way round is what the shape check catches", async () => {
  // Presence cannot be red here — the startup gate exits before doctor can
  // run without them — so the kind of token is what is left to be wrong.
  const swapped = {
    SLACK_BOT_TOKEN: "xapp-test",
    SLACK_APP_TOKEN: "xoxb-test",
  } as NodeJS.ProcessEnv;

  const bot = await check("slack.bot-token", { env: swapped });
  expect(bot.ok).toBe(false);
  if (bot.ok) return;
  expect(bot.reason).toBe("SLACK_BOT_TOKEN is not a xoxb-… token");
  expect(bot.repair).toContain("Bot User OAuth Token");
  expect(bot.repair).toContain("the factory repo's .env");

  const app = await check("slack.app-token", { env: swapped });
  expect(app.ok).toBe(false);
  if (app.ok) return;
  expect(app.reason).toBe("SLACK_APP_TOKEN is not a xapp-… token");
  expect(app.repair).toContain("connections:write");
});

test("a wrong-kind bot token is not probed at all", async () => {
  let probed = 0;
  const result = await check("slack.bot-token", {
    env: { SLACK_BOT_TOKEN: "xoxp-a-user-token" } as NodeJS.ProcessEnv,
    probes: {
      authTest: async () => {
        probed += 1;
        return { ok: true };
      },
    },
  });
  expect(result.ok).toBe(false);
  expect(probed).toBe(0);
});

test("a channel the bot can see but has not joined is repaired by an invite", async () => {
  // conversations.info answers ok for a public channel the bot is not in, so
  // the ok is not the answer — is_member is.
  const result = await check("slack.channel", {
    probes: {
      conversationsInfo: async () => ({ channel: { is_member: false } }),
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("the bot is not a member of C0RUNS");
  expect(result.repair).toContain("/invite @jigs");
});

test("an archived channel is repaired by picking a live one", async () => {
  const result = await check("slack.channel", {
    probes: {
      conversationsInfo: async () => ({
        channel: { is_member: true, is_archived: true },
      }),
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("C0RUNS is archived");
  expect(result.repair).toContain("a live channel");
});

test("a channel Slack cannot find at all is repaired the same way as an uninvited one", async () => {
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
  expect(result.repair).toContain("/invite @jigs");
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

test("a token of the wrong kind reads as a wrong kind, not a missing scope", async () => {
  const result = await check("slack.bot-token", {
    probes: {
      authTest: () => Promise.reject(platformError("not_allowed_token_type")),
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.repair).toContain("takes a bot token");
  expect(result.repair).not.toContain("missing a scope");
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
