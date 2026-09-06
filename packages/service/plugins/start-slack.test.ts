import type { SlackConfig } from "jigs";
import { expect, test } from "vitest";
import { startSlack } from "./start-slack";

const SLACK: SlackConfig = {
  channel: "C0RUNS",
  allowed_users: ["U0ALLOWED", "U0OTHER"],
  model: "anthropic/claude-sonnet-4.5",
};

const BOTH_TOKENS = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
} as NodeJS.ProcessEnv;

function harness(over: Parameters<typeof startSlack>[0] = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const connected: unknown[] = [];
  return {
    logs,
    errors,
    exits,
    connected,
    run: () =>
      startSlack({
        slack: () => SLACK,
        env: BOTH_TOKENS,
        connect: async (options) => {
          connected.push(options);
          return {
            start: async () => ({}),
            disconnect: async () => {},
            on: () => {},
          };
        },
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
        exit: (code) => exits.push(code),
        ...over,
      }),
  };
}

test("a factory with no slack block starts normally, saying so once", async () => {
  const h = harness({ slack: () => null, env: {} });
  expect(await h.run()).toBe(true);
  expect(h.exits).toEqual([]);
  expect(h.connected).toEqual([]);
  expect(h.logs).toEqual(["[slack] skipped: jigs.yml declares no slack block"]);
});

test("a declared block connects with the app token and the allowlist", async () => {
  const h = harness();
  expect(await h.run()).toBe(true);
  expect(h.exits).toEqual([]);
  expect(h.connected[0]).toMatchObject({
    appToken: "xapp-test",
    allowedUsers: SLACK.allowed_users,
  });
  expect(h.logs.at(-1)).toBe(
    "[slack] listening: channel C0RUNS, 2 allowed user(s)",
  );
});

test("a declared block without its tokens exits rather than starting half on", async () => {
  const h = harness({ env: {} });
  expect(await h.run()).toBe(false);
  expect(h.exits).toEqual([1]);
  expect(h.connected).toEqual([]);
  expect(h.errors[0]).toContain("SLACK_BOT_TOKEN and SLACK_APP_TOKEN unset");
  expect(h.errors[1]).toContain("the factory repo's .env");
});

test("one missing token names only the one that is missing", async () => {
  const h = harness({
    env: { SLACK_BOT_TOKEN: "xoxb-test" } as NodeJS.ProcessEnv,
  });
  expect(await h.run()).toBe(false);
  expect(h.errors[0]).toContain("SLACK_APP_TOKEN unset");
  expect(h.errors[0]).not.toContain("SLACK_BOT_TOKEN");
});

test("a connection Slack refuses exits with the app-token repair", async () => {
  const h = harness({
    connect: () => Promise.reject(new Error("invalid_auth")),
  });
  expect(await h.run()).toBe(false);
  expect(h.exits).toEqual([1]);
  expect(h.errors[0]).toContain("invalid_auth");
  expect(h.errors[1]).toContain("connections:write");
});

test("an unreadable factory config exits instead of skipping Slack silently", async () => {
  const h = harness({
    slack: () => {
      throw new Error("invalid jigs.yml: bad indentation");
    },
  });
  expect(await h.run()).toBe(false);
  expect(h.exits).toEqual([1]);
  expect(h.errors[0]).toContain("bad indentation");
});
