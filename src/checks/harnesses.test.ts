import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import type { CheckResult } from "./catalog.ts";
import { claudeAuthCheck, codexAuthCheck } from "./harnesses.ts";

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
  expect(result.ok === false && result.repair).toContain(
    "the factory repo's .env",
  );
});

test("the probe spawns the CLI with the unscrubbed env, so an API key can flip its auth mode", async () => {
  let spawned: Record<string, string> | undefined;
  await claudeAuthCheck({
    env: { ...claudeEnv, ANTHROPIC_API_KEY: "sk-x" },
    exec: async (_file, _args, options) => {
      spawned = options.env;
      return { stdout: JSON.stringify(API_KEY_OVERRIDE) };
    },
  }).run();
  expect(spawned).toHaveProperty("ANTHROPIC_API_KEY", "sk-x");
});

test("a logged-out CLI fails with claude auth login", async () => {
  const result = await claudeResult(JSON.stringify({ loggedIn: false }));
  expect(result).toMatchObject({
    ok: false,
    repair: "run: claude auth login",
  });
});

test("a non-subscription authMethod fails naming the method found", async () => {
  const result = await claudeResult(
    JSON.stringify({ loggedIn: true, authMethod: "bedrock" }),
  );
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
