import { WebAPIPlatformError } from "@slack/web-api";
import { MockLanguageModelV3 } from "ai/test";
import type { SlackConfig } from "jigs";
import { expect, test } from "vitest";
import { z } from "zod";
import type { Factory } from "../src/factory";
import type { SlackMessage, SlackWeb } from "../src/slack/web";
import { startSlack } from "./start-slack";

const SLACK: SlackConfig = {
  channel: "C0RUNS",
  allowed_users: ["U0ALLOWED", "U0OTHER"],
  model: "anthropic/claude-sonnet-4.5",
};

const CREDENTIALS = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  OPENROUTER_API_KEY: "sk-or-test",
} as NodeJS.ProcessEnv;

const FACTORY: Factory = {
  pipelines: {
    ticket: { pipeline: async () => ({}), inputs: z.object({}) },
  },
};

const platformError = (error: string) =>
  new WebAPIPlatformError({ ok: false, error } as {
    ok: boolean;
    error: string;
  });

function fakeWeb(over: Partial<SlackWeb> = {}) {
  const posted: Array<[string, string, string]> = [];
  const web: SlackWeb = {
    authTest: async () => ({ userId: "U0JIGS", botId: "B0JIGS" }),
    replies: async (): Promise<SlackMessage[]> => [],
    post: async (channel, threadTs, text) => {
      posted.push([channel, threadTs, text]);
    },
    ...over,
  };
  return { web, posted };
}

function harness(over: Parameters<typeof startSlack>[1] = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const connected: unknown[] = [];
  const { web } = fakeWeb();
  const slept: number[] = [];
  return {
    logs,
    errors,
    exits,
    connected,
    slept,
    run: () =>
      startSlack(FACTORY, {
        slack: () => SLACK,
        env: CREDENTIALS,
        web: () => web,
        sleep: async (ms) => {
          slept.push(ms);
        },
        model: () => new MockLanguageModelV3(),
        connect: async (options) => {
          connected.push(options);
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

test("a declared block connects with the app token, the allowlist and a dispatcher", async () => {
  const h = harness();
  expect(await h.run()).toBe(true);
  expect(h.exits).toEqual([]);
  expect(h.connected[0]).toMatchObject({
    appToken: "xapp-test",
    allowedUsers: SLACK.allowed_users,
  });
  expect((h.connected[0] as { dispatch: unknown }).dispatch).toBeTypeOf(
    "function",
  );
  expect(h.logs.at(-1)).toBe(
    "[slack] listening: channel C0RUNS, model anthropic/claude-sonnet-4.5, 2 allowed user(s)",
  );
});

test("the model is resolved from the block's model id and the service's own env", async () => {
  const asked: Array<[string, NodeJS.ProcessEnv]> = [];
  const h = harness({
    model: (modelId, env) => {
      asked.push([modelId, env]);
      return new MockLanguageModelV3();
    },
  });
  await h.run();
  expect(asked).toEqual([["anthropic/claude-sonnet-4.5", CREDENTIALS]]);
});

test("a declared block without its credentials exits rather than starting half on", async () => {
  const h = harness({ env: {} });
  expect(await h.run()).toBe(false);
  expect(h.exits).toEqual([1]);
  expect(h.connected).toEqual([]);
  expect(h.errors[0]).toContain(
    "SLACK_BOT_TOKEN, SLACK_APP_TOKEN and OPENROUTER_API_KEY unset",
  );
  expect(h.errors[1]).toContain("the factory repo's .env");
});

test("one missing credential names only the one that is missing", async () => {
  const h = harness({
    env: {
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APP_TOKEN: "xapp-test",
    } as NodeJS.ProcessEnv,
  });
  expect(await h.run()).toBe(false);
  expect(h.errors[0]).toContain("OPENROUTER_API_KEY unset");
  expect(h.errors[0]).not.toContain("SLACK_BOT_TOKEN");
});

test("a bot token Slack has rejected exits before the socket, without retrying", async () => {
  // Without auth.test the bot has no id of its own, and every reply it has
  // already made in a thread reads back as the operator having said it. Slack
  // naming the token is the one answer waiting cannot improve.
  const { web } = fakeWeb({
    authTest: () => Promise.reject(platformError("invalid_auth")),
  });
  const h = harness({ web: () => web });
  expect(await h.run()).toBe(false);
  expect(h.exits).toEqual([1]);
  expect(h.connected).toEqual([]);
  expect(h.slept).toEqual([]);
  expect(h.errors[0]).toContain("invalid_auth");
  expect(h.errors[1]).toContain("Bot User OAuth Token");
});

test("a transient auth.test failure is retried, and one good answer is enough", async () => {
  let calls = 0;
  const { web } = fakeWeb({
    authTest: async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNRESET");
      return { userId: "U0JIGS", botId: "B0JIGS" };
    },
  });
  const h = harness({ web: () => web });
  expect(await h.run()).toBe(true);
  expect(h.exits).toEqual([]);
  expect(h.slept).toEqual([2_000, 5_000]);
  expect(h.connected).toHaveLength(1);
});

test("Slack being unreachable starts the factory without Slack rather than not at all", async () => {
  // This factory's runs do not depend on Slack. A service that refuses to
  // start is a worse answer than one that starts without a feature nobody
  // could reach anyway — the same posture a failed schedule takes.
  const { web } = fakeWeb({
    authTest: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
  });
  const h = harness({ web: () => web });
  expect(await h.run()).toBe(true);
  expect(h.exits).toEqual([]);
  expect(h.connected).toEqual([]);
  expect(h.slept).toEqual([2_000, 5_000, 10_000]);
  expect(h.logs.at(-1)).toBe(
    "[slack] skipped: could not reach Slack (getaddrinfo ENOTFOUND)",
  );
});

test("a Slack error that is not about the token is transient, not fatal", async () => {
  // `ratelimited`, a 500, a proxy hiccup — none of them say the token is bad.
  const { web } = fakeWeb({
    authTest: () => Promise.reject(platformError("ratelimited")),
  });
  const h = harness({ web: () => web });
  expect(await h.run()).toBe(true);
  expect(h.exits).toEqual([]);
  expect(h.logs.at(-1)).toContain("could not reach Slack (ratelimited)");
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
