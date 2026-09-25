import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harnesses } from "../blocks/agents/harness-config.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import type { CheckResult } from "./catalog.ts";
import {
  claudeAuthCheck,
  codexAuthCheck,
  harnessRuntimeCheck,
  harnessUsers,
  piOpenaiCodexAuthCheck,
} from "./harnesses.ts";

let tmp: string;

beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  removeTmpDir(tmp);
});

// Both payloads are verbatim `claude auth status --json` output — the clean
// one and the one the CLI emits with ANTHROPIC_API_KEY exported.
const SUBSCRIPTION = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  analyticsDisabled: false,
  email: "dev@example.com",
  orgId: "org-1",
  orgName: "Example",
  subscriptionType: "team",
};

const API_KEY_OVERRIDE = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  analyticsDisabled: false,
  apiKeySource: "ANTHROPIC_API_KEY",
  email: null,
  orgId: null,
  orgName: null,
  subscriptionType: null,
};

const claudeEnv = { JIGS_CLAUDE_EXECUTABLE: "/usr/bin/claude", PATH: "" };

function claudeResult(stdout: string): Promise<CheckResult> {
  return claudeAuthCheck({
    env: claudeEnv,
    factoryEnv: () => [],
    exec: async () => ({ stdout }),
  }).run();
}

test("a claude.ai subscription login passes", async () => {
  expect(await claudeResult(JSON.stringify(SUBSCRIPTION))).toEqual({
    ok: true,
  });
});

test("an ANTHROPIC_API_KEY overriding the subscription login fails and names the env var to remove", async () => {
  const result = await claudeResult(JSON.stringify(API_KEY_OVERRIDE));
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("ANTHROPIC_API_KEY"),
    repair: expect.stringContaining("ANTHROPIC_API_KEY"),
  });
  expect(result.ok === false && result.repair).toContain("the factory repo's .env");
});

test("the probe spawns the CLI under the environment a Claude step gets", async () => {
  let spawned: Record<string, string> | undefined;
  await claudeAuthCheck({
    env: {
      ...claudeEnv,
      ANTHROPIC_API_KEY: "sk-x",
      SYNTHETIC_DATABASE_URL: "postgres://user:secret@db/app",
      CLAUDE_CONFIG_DIR: "/home/tester/.claude-work",
      DECLARED_BY_FACTORY: "declared",
    },
    factoryEnv: () => ["DECLARED_BY_FACTORY"],
    exec: async (_file, _args, options) => {
      spawned = options.env;
      return { stdout: JSON.stringify(SUBSCRIPTION) };
    },
  }).run();
  expect(Object.keys(spawned ?? {}).sort()).toEqual([
    "CLAUDE_CONFIG_DIR",
    "DECLARED_BY_FACTORY",
    "PATH",
  ]);
});

test("a logged-out CLI fails with claude auth login", async () => {
  const result = await claudeResult(JSON.stringify({ loggedIn: false }));
  expect(result).toMatchObject({
    ok: false,
    repair: "run: claude auth login",
  });
});

test("a non-subscription authMethod fails naming the method found", async () => {
  const result = await claudeResult(JSON.stringify({ loggedIn: true, authMethod: "bedrock" }));
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("bedrock"),
  });
});

test("unparseable CLI output fails closed", async () => {
  const result = await claudeResult("claude: command needs an update");
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("did not answer JSON"),
  });
});

test("a claude CLI that cannot be found fails with an install repair", async () => {
  const result = await claudeAuthCheck({
    env: { PATH: path.join(tmp, "empty") },
    exec: async () => {
      throw new Error("should not run");
    },
  }).run();
  expect(result).toMatchObject({
    ok: false,
    repair: expect.stringContaining("JIGS_CLAUDE_EXECUTABLE"),
  });
});

const authFile = (contents: unknown): string => {
  const file = path.join(tmp, "auth.json");
  writeFileSync(file, JSON.stringify(contents));
  return file;
};

test("a chatgpt-mode auth.json passes", async () => {
  const file = authFile({ auth_mode: "chatgpt", OPENAI_API_KEY: null });
  expect(await codexAuthCheck(file).run()).toEqual({ ok: true });
});

test("an api-key auth.json fails naming the mode found", async () => {
  const file = authFile({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" });
  const result = await codexAuthCheck(file).run();
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("apikey"),
    repair: expect.stringContaining("codex login"),
  });
});

test("a missing auth.json fails with codex login", async () => {
  const result = await codexAuthCheck(path.join(tmp, "absent.json")).run();
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("no Codex login found"),
    repair: "run: codex login",
  });
});

test("an expired-looking token is not gated on", async () => {
  const file = authFile({
    auth_mode: "chatgpt",
    tokens: { access_token: "stale" },
    last_refresh: "2024-01-01T00:00:00.000Z",
  });
  expect(await codexAuthCheck(file).run()).toEqual({ ok: true });
});

test("Pi OpenAI Codex auth requires the provider entry", async () => {
  const present = authFile({ "openai-codex": { type: "oauth" } });
  expect(await piOpenaiCodexAuthCheck(present).run()).toEqual({ ok: true });

  const absent = authFile({ anthropic: { type: "oauth" } });
  expect(await piOpenaiCodexAuthCheck(absent).run()).toMatchObject({
    ok: false,
    reason: expect.stringContaining("no OpenAI Codex login"),
  });
});

// Doctor shows the same line the boot would have refused on.
test("the CLI check reports the shared line, as detail when it passes", async () => {
  const result = await harnessRuntimeCheck("codex", {
    factoryEnv: () => [],
    resolve: () => "/usr/local/bin/codex",
    exec: async () => ({ stdout: "codex-cli 0.153.4", stderr: "" }),
  }).run();
  expect(result).toMatchObject({ ok: true });
  expect((result as { detail: string }).detail).toContain("codex 0.153.4 at /usr/local/bin/codex");
});

test("the CLI check fails with the same line as the reason, and the PATH caveat to repair it", async () => {
  const result = await harnessRuntimeCheck("codex", {
    factoryEnv: () => [],
    resolve: () => "/usr/local/bin/codex",
    exec: async () => ({ stdout: "codex-cli 0.144.6", stderr: "" }),
  }).run();
  expect(result).toMatchObject({ ok: false });
  const failure = result as { reason: string; repair: string };
  expect(failure.reason).toContain("below the minimum");
  expect(failure.repair).toContain("same PATH as your shell");
});

test("harness users are derived from each workflow's agents", () => {
  expect(
    harnessUsers({
      hello: {},
      review: {
        requires: {
          agents: { reviewer: harnesses.claude("opus"), second: harnesses.claude("sonnet") },
        },
      },
      ship: {
        requires: {
          agents: { builder: harnesses.codex("gpt-5.5"), reviewer: harnesses.claude("opus") },
        },
      },
    }),
  ).toEqual(
    new Map([
      ["claude", ["review", "ship"]],
      ["codex", ["ship"]],
    ]),
  );
  expect(harnessUsers({ hello: {} })).toEqual(new Map());
});
