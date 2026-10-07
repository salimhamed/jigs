import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harnesses } from "../../../workflow/agents/harness-config.ts";
import { buildAgentRequest, buildAskAgentRequest } from "../../../workflow/agents/plan.ts";
import { prepareClaudeSkillsPlugin } from "../shared/skills.ts";
import { makeTmpDir, removeTmpDir } from "../shared/test-fixtures.ts";
import type { RunRequest } from "../shared/types.ts";
import { createClaudeDriver } from "./driver.ts";
import { claudeResult, fakeClaudeQuery } from "./test-fixtures.ts";

const registry = vi.hoisted(() => ({ recordRunDirectory: vi.fn(async () => {}) }));
vi.mock("../../runtime/registry.ts", () => registry);

let tmp: string;
let worktree: string;
let skill: string;
let pluginBase: string;

beforeEach(() => {
  tmp = makeTmpDir();
  worktree = path.join(tmp, "worktree");
  mkdirSync(worktree);
  skill = path.join(tmp, "factory", "skills", "snowflake");
  mkdirSync(skill, { recursive: true });
  writeFileSync(path.join(skill, "SKILL.md"), "---\nname: snowflake\n---\n");
  pluginBase = path.join(tmp, "plugins");
  vi.stubEnv("JIGS_CLAUDE_EXECUTABLE", "/fake/claude");
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

let query = fakeClaudeQuery();
beforeEach(() => {
  query = fakeClaudeQuery();
});

const driver = () =>
  createClaudeDriver({
    query,
    sessionMessages: async () => [{ type: "user" }],
    prepareSkillsPlugin: async (runId, skills) =>
      prepareClaudeSkillsPlugin(runId, skills, { baseDir: pluginBase }),
    openStepStream: () => undefined,
  });
const context = () => ({
  metadata: { workflowRunId: "wrun_skills" },
  deps: {} as never,
  env: {},
  signal: new AbortController().signal,
});
const queried = () => {
  const call = query.calls.at(-1);
  if (call === undefined) throw new Error("no Claude query captured");
  return call.options;
};

const runRequest = (skills?: string[]) =>
  buildAgentRequest({
    harness: harnesses.claude({ model: "opus", ...(skills === undefined ? {} : { skills }) }),
    cwd: worktree,
    prompt: "work",
  }) as RunRequest;

test("a run loads the declared skills as a private plugin that it removes afterwards", async () => {
  let loaded = false;
  query = fakeClaudeQuery(({ options }) => {
    const plugin = options.plugins?.[0]?.path ?? "";
    loaded = existsSync(path.join(plugin, "skills", "snowflake", "SKILL.md"));
    return [claudeResult()];
  });
  await driver().run?.(runRequest([skill]), context());

  const options = queried();
  expect(options.plugins?.[0]).toMatchObject({ type: "local", skipMcpDiscovery: true });
  expect(loaded).toBe(true);
  expect(options.settingSources).toEqual(["project"]);
  expect(options.strictMcpConfig).toBe(true);
  expect(options.skills).toBeUndefined();
  expect(readdirSync(path.join(pluginBase, "wrun_skills"))).toEqual([]);
});

test("the plugin lives in a per-run folder recorded as the run's claude-plugins resource", async () => {
  vi.stubEnv("XDG_DATA_HOME", tmp);
  const runFolder = path.join(tmp, "jigs", "claude-plugins", "wrun_skills");
  await createClaudeDriver({
    query,
    sessionMessages: async () => [{ type: "user" }],
    openStepStream: () => undefined,
  }).run?.(runRequest([skill]), context());

  expect(registry.recordRunDirectory).toHaveBeenCalledWith(
    "claude-plugins",
    "wrun_skills",
    runFolder,
  );
  expect(path.dirname(queried().plugins?.[0]?.path ?? "")).toBe(runFolder);
  expect(readdirSync(runFolder)).toEqual([]);
});

test("a run without skills builds no plugin", async () => {
  await driver().run?.(runRequest(), context());
  expect(queried().plugins).toBeUndefined();
  expect(existsSync(pluginBase)).toBe(false);
});

test("a failed run removes the plugin it built", async () => {
  query = fakeClaudeQuery(() => {
    throw new Error("Claude Code process failed");
  });
  await expect(driver().run?.(runRequest([skill]), context())).rejects.toThrow(
    "Claude Code process failed",
  );
  expect(readdirSync(path.join(pluginBase, "wrun_skills"))).toEqual([]);
});

test("ask builds no plugin even when the descriptor declares skills", async () => {
  await driver().ask?.(
    buildAskAgentRequest({
      harness: harnesses.claude({ model: "opus", skills: [skill] }),
      prompt: "hi",
    }),
    context(),
  );
  expect(queried().plugins).toBeUndefined();
  expect(existsSync(pluginBase)).toBe(false);
});
