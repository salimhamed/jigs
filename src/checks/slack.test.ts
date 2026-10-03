import { expect, test } from "vitest";
import { SlackApiError, type SlackAuth, type SlackToken } from "../providers/slack.ts";
import {
  type SlackProbes,
  slackIdentityChecks,
  slackSharedAppChecks,
  slackSocketModeChecks,
} from "./slack.ts";

const AUTH: SlackAuth = {
  userId: "U0C59SU5V29",
  botId: "B0C5JPZUW1J",
  user: "salims_jigs",
  team: "Jungle Scout",
  scopes: ["channels:history", "groups:history", "chat:write", "users:read", "users:read.email"],
};

const probes = (overrides: Partial<SlackProbes> = {}): SlackProbes => ({
  authTest: async () => AUTH,
  openConnection: async () => "wss://wss-primary.slack.com/link/?ticket=t",
  ...overrides,
});

const env =
  (values: Partial<Record<SlackToken, string>>) =>
  (name: SlackToken): string | undefined =>
    values[name];
const BOTH = env({ SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1" });

async function run(socketMode: boolean, p: SlackProbes, lookup = BOTH, scopes: string[] = []) {
  const checks = [
    ...slackIdentityChecks(p, scopes, lookup),
    ...slackSocketModeChecks({ socketMode }, p, lookup),
  ];
  return Promise.all(
    checks.map(async (check) => ({
      id: check.id,
      ...(await check.run()),
    })),
  );
}

test("a bot token with every scope passes, naming the bot", async () => {
  expect(await run(false, probes())).toEqual([
    { id: "slack.identity", ok: true, detail: "acting as @salims_jigs in Jungle Scout" },
  ]);
});

test("an unset bot token names the .env key and makes no call", async () => {
  let called = false;
  const [identity] = await run(
    false,
    probes({
      authTest: async () => {
        called = true;
        return AUTH;
      },
    }),
    env({}),
  );
  expect(identity).toMatchObject({ ok: false, reason: "SLACK_BOT_TOKEN is not set" });
  expect(identity).toHaveProperty("repair", expect.stringContaining("SLACK_BOT_TOKEN"));
  expect(called).toBe(false);
});

test("a token Slack rejects says so and names the key to replace", async () => {
  const [identity] = await run(
    false,
    probes({
      authTest: async () => {
        throw new SlackApiError("auth.test", "invalid_auth");
      },
    }),
  );
  expect(identity).toMatchObject({
    ok: false,
    reason: "SLACK_BOT_TOKEN is set but Slack rejected it: Slack auth.test: invalid_auth",
  });
  expect(identity).toHaveProperty("repair", expect.stringContaining("SLACK_BOT_TOKEN"));
});

test("missing scopes are each named in the reason and the repair", async () => {
  const [identity] = await run(
    false,
    probes({
      authTest: async () => ({
        ...AUTH,
        scopes: ["channels:history", "groups:history", "chat:write"],
      }),
    }),
  );
  expect(identity).toMatchObject({
    ok: false,
    reason: "the bot token lacks users:read and users:read.email",
  });
  expect(identity).toHaveProperty(
    "repair",
    expect.stringContaining("add users:read and users:read.email to the Bot Token Scopes"),
  );
});

test("a scope the factory declares in slack.scopes is checked like jigs' own", async () => {
  const [identity] = await run(false, probes(), BOTH, ["reactions:write", "chat:write"]);
  expect(identity).toMatchObject({ ok: false, reason: "the bot token lacks reactions:write" });
  expect(identity).toHaveProperty(
    "repair",
    expect.stringContaining("add reactions:write to the Bot Token Scopes"),
  );
  const [granted] = await run(
    false,
    probes({ authTest: async () => ({ ...AUTH, scopes: [...AUTH.scopes, "reactions:write"] }) }),
    BOTH,
    ["reactions:write"],
  );
  expect(granted).toMatchObject({ ok: true });
});

test("an unreachable Slack is not blamed on the token", async () => {
  const [identity] = await run(
    false,
    probes({
      authTest: async () => {
        throw new TypeError("fetch failed");
      },
    }),
  );
  expect(identity).toMatchObject({
    ok: false,
    reason: "Slack could not be reached: fetch failed",
    repair: expect.stringContaining("retry"),
  });
});

test("with Socket Mode on, the app-level token must open a connection", async () => {
  expect(await run(true, probes())).toEqual([
    expect.objectContaining({ id: "slack.identity", ok: true }),
    { id: "slack.socket-mode", ok: true },
  ]);
});

test("with Socket Mode on and no app-level token, the repair names SLACK_APP_TOKEN", async () => {
  const [, socket] = await run(true, probes(), env({ SLACK_BOT_TOKEN: "xoxb-1" }));
  expect(socket).toMatchObject({
    ok: false,
    reason: "slack.socketMode is on but SLACK_APP_TOKEN is not set",
  });
  expect(socket).toHaveProperty("repair", expect.stringContaining("connections:write"));
});

test("an app-level token without connections:write names the scope", async () => {
  const [, socket] = await run(
    true,
    probes({
      openConnection: async () => {
        throw new SlackApiError("apps.connections.open", "missing_scope", "connections:write");
      },
    }),
  );
  expect(socket).toMatchObject({ ok: false });
  expect(socket).toHaveProperty(
    "repair",
    expect.stringContaining("create an app-level token with the connections:write scope"),
  );
});

test("a bot token in SLACK_APP_TOKEN is called out", async () => {
  const [, socket] = await run(
    true,
    probes({
      openConnection: async () => {
        throw new SlackApiError("apps.connections.open", "not_allowed_token_type");
      },
    }),
  );
  expect(socket).toHaveProperty("repair", expect.stringContaining("xapp-"));
});

test("with Socket Mode off there is no connection check", async () => {
  expect((await run(false, probes())).map((check) => check.id)).toEqual(["slack.identity"]);
});

async function sharing(others: readonly string[], socketMode = true, lookup = BOTH) {
  return Promise.all(
    slackSharedAppChecks({ socketMode }, () => others, lookup).map(async (check) => ({
      id: check.id,
      label: check.label,
      ...(await check.run()),
    })),
  );
}

test("a Slack app no other service on this machine uses passes", async () => {
  expect(await sharing([])).toEqual([
    { id: "slack.shared-app", label: "Slack app sharing", ok: true },
  ]);
});

test("another service on the same Slack app fails, naming it and the split", async () => {
  const [check] = await sharing(["jigs-factory-js-1a2b3c4d"]);
  expect(check).toMatchObject({
    ok: false,
    reason:
      "SLACK_APP_TOKEN belongs to the same Slack app as the running service jigs-factory-js-1a2b3c4d; Slack splits Socket Mode events between them, so each factory misses some until its poll catches up",
  });
  expect(check).toHaveProperty(
    "repair",
    expect.stringContaining("create a separate Slack app for this factory"),
  );
});

test("several other services are each named", async () => {
  const [check] = await sharing(["factory-a", "factory-b"]);
  expect(check).toHaveProperty(
    "reason",
    expect.stringContaining("the running services factory-a and factory-b;"),
  );
});

test("the sharing check is left out without Socket Mode or an app-level token", async () => {
  expect(await sharing(["factory-a"], false)).toEqual([]);
  expect(await sharing(["factory-a"], true, env({ SLACK_BOT_TOKEN: "xoxb-1" }))).toEqual([]);
});
