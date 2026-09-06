import { WebAPIPlatformError } from "@slack/web-api";
import { MockLanguageModelV3 } from "ai/test";
import type { SlackConfig } from "jigs";
import type { ISql } from "postgres";
import { expect, test } from "vitest";
import { z } from "zod";
import type { Factory } from "../src/factory";
import type { RunStarted, RunStartedListener } from "../src/run-events";
import type { RunRow } from "../src/runs";
import type { RunThreads, RunThreadsDeps } from "../src/slack/run-threads";
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
    open: async () => "1757.0001",
    ...over,
  };
  return { web, posted };
}

const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";

const runRow = (over: Partial<RunRow> = {}): RunRow => ({
  runId: RUN,
  pipeline: "ticket",
  status: "running",
  trigger: "manual",
  createdAt: "2026-09-06T10:00:00.000Z",
  ...over,
});

/** A stand-in for the run-thread bookkeeping: what the plugin owes it is that
 *  it is built with the block's channel, subscribed to run starts, and handed
 *  the runs still in flight. What it then does is run-threads.test.ts's. */
function fakeRunThreads() {
  const built: RunThreadsDeps[] = [];
  const startedWith: RunStarted[] = [];
  const rehydratedWith: string[][] = [];
  const threads: RunThreads = {
    runStarted: async (event) => {
      startedWith.push(event);
    },
    rehydrate: async (runIds) => {
      rehydratedWith.push([...runIds]);
    },
    threadRun: async () => null,
    stop: () => undefined,
  };
  return {
    built,
    startedWith,
    rehydratedWith,
    make: (deps: RunThreadsDeps) => {
      built.push(deps);
      return threads;
    },
  };
}

function harness(over: Parameters<typeof startSlack>[1] = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const connected: unknown[] = [];
  const { web } = fakeWeb();
  const slept: number[] = [];
  const ensured: ISql[] = [];
  const listeners: RunStartedListener[] = [];
  return {
    logs,
    errors,
    exits,
    connected,
    slept,
    ensured,
    listeners,
    run: () =>
      startSlack(FACTORY, {
        slack: () => SLACK,
        env: CREDENTIALS,
        web: () => web,
        sleep: async (ms) => {
          slept.push(ms);
        },
        model: () => new MockLanguageModelV3(),
        // Never the real one: these tests must reach no database, and the
        // default reads the service's own WORKFLOW_POSTGRES_URL.
        sql: () => ({}) as ISql,
        ensureThreads: async (sql) => {
          ensured.push(sql);
        },
        onRunStarted: (listener) => {
          listeners.push(listener);
          return () => undefined;
        },
        listRuns: async () => [],
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

const startedEvent: RunStarted = {
  runId: RUN,
  pipeline: "ticket",
  triggerId: "manual-1",
  logs: `http://localhost:3001/run/${RUN}`,
};

test("the thread table is ensured before the socket, like the World's own gates", async () => {
  const h = harness();
  expect(await h.run()).toBe(true);
  expect(h.ensured).toHaveLength(1);
});

test("a thread table the World will not answer for exits rather than starting half on", async () => {
  const h = harness({
    ensureThreads: () => Promise.reject(new Error("relation is not a table")),
  });
  expect(await h.run()).toBe(false);
  expect(h.exits).toEqual([1]);
  expect(h.connected).toEqual([]);
  expect(h.errors[0]).toContain("jigs_slack_threads unusable");
  expect(h.errors[1]).toContain("WORKFLOW_POSTGRES_URL");
});

test("a factory with no World Postgres answers threads without mapping runs to them", async () => {
  const h = harness({ sql: () => null });
  expect(await h.run()).toBe(true);
  expect(h.ensured).toEqual([]);
  expect(h.connected).toHaveLength(1);
  expect(h.logs).toContain(
    "[slack] run threads skipped: WORKFLOW_POSTGRES_URL unset",
  );
});

test("every run this service starts is handed to the run threads, in the block's channel", async () => {
  const threads = fakeRunThreads();
  const h = harness({ runThreads: threads.make });
  await h.run();
  expect(threads.built[0]?.channel).toBe("C0RUNS");
  const event: RunStarted = {
    runId: RUN,
    pipeline: "ticket",
    triggerId: "manual-1",
    logs: `http://localhost:3001/run/${RUN}`,
  };
  h.listeners[0]?.(event);
  expect(threads.startedWith).toEqual([event]);
});

test("the runs still in flight are picked back up at start, and the finished ones are not", async () => {
  const threads = fakeRunThreads();
  const h = harness({
    runThreads: threads.make,
    listRuns: async () => [
      runRow(),
      runRow({ runId: "wrun_02", status: "suspended" }),
      runRow({ runId: "wrun_03", status: "completed" }),
      runRow({ runId: "wrun_04", status: "cancelled" }),
    ],
  });
  expect(await h.run()).toBe(true);
  expect(threads.rehydratedWith).toEqual([[RUN, "wrun_02"]]);
});

test("a World that will not list its runs costs the factory its watchers, not its Slack app", async () => {
  const threads = fakeRunThreads();
  const h = harness({
    runThreads: threads.make,
    listRuns: () => Promise.reject(new Error("world unreachable")),
  });
  expect(await h.run()).toBe(true);
  expect(h.connected).toHaveLength(1);
  expect(h.errors.at(-1)).toContain("world unreachable");
});

test("a run started while the auth probe is still backing off is threaded once it is ready", async () => {
  // Nitro neither awaits this plugin nor holds the trigger route open on it,
  // so `jigs run` answers during the backoff. That run is exactly the one a
  // first start is about.
  const threads = fakeRunThreads();
  let attempts = 0;
  const emitted: Array<() => void> = [];
  const { web } = fakeWeb({
    authTest: async () => {
      attempts += 1;
      emitted[0]?.();
      if (attempts < 2) throw new Error("ECONNRESET");
      return { userId: "U0JIGS", botId: "B0JIGS" };
    },
  });
  const h = harness({
    web: () => web,
    runThreads: threads.make,
    onRunStarted: (listener) => {
      emitted.push(() => listener(startedEvent));
      return () => {
        emitted.length = 0;
      };
    },
  });
  expect(await h.run()).toBe(true);
  expect(threads.startedWith).toEqual([startedEvent, startedEvent]);
});

test("a run started while Slack is rejecting the token is dropped, not queued forever", async () => {
  const threads = fakeRunThreads();
  const emitted: Array<() => void> = [];
  const { web } = fakeWeb({
    authTest: () => {
      emitted[0]?.();
      return Promise.reject(platformError("invalid_auth"));
    },
  });
  const h = harness({
    web: () => web,
    runThreads: threads.make,
    onRunStarted: (listener) => {
      emitted.push(() => listener(startedEvent));
      return () => {
        emitted.length = 0;
      };
    },
  });
  expect(await h.run()).toBe(false);
  expect(threads.startedWith).toEqual([]);
  expect(emitted).toEqual([]);
});
