import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harnesses } from "../../../workflow/agents/harness-config.ts";
import { buildAskAgentRequest } from "../../../workflow/agents/plan.ts";
import { prepareClaudeSkillsPlugin } from "../shared/skills.ts";
import { makeTmpDir, removeTmpDir } from "../shared/test-fixtures.ts";
import { createClaudeDriver } from "./driver.ts";

const registry = vi.hoisted(() => ({ recordRunDirectory: vi.fn(async () => {}) }));
vi.mock("../../runtime/registry.ts", () => registry);

// The Claude driver wraps the model it opens, so its settings are read where
// the driver builds them.
const claudeSettings = vi.hoisted(() => [] as ClaudeCodeSettings[]);
vi.mock("ai-sdk-provider-claude-code", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai-sdk-provider-claude-code")>();
  return {
    ...actual,
    claudeCode: (modelId: string, settings: ClaudeCodeSettings) => {
      claudeSettings.push(settings);
      return actual.claudeCode(modelId, settings);
    },
  };
});

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
  claudeSettings.length = 0;
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

const driver = () =>
  createClaudeDriver({
    sessionMessages: async () => [{ type: "user" }],
    prepareSkillsPlugin: async (runId, skills) =>
      prepareClaudeSkillsPlugin(runId, skills, { baseDir: pluginBase }),
  });
const context = () => ({
  metadata: { workflowRunId: "wrun_skills" },
  env: {},
  signal: new AbortController().signal,
});
const openedSettings = () => {
  const settings = claudeSettings.at(-1);
  if (settings === undefined) throw new Error("no claude settings captured");
  return settings;
};
const settingsOf = (model: unknown) => (model as { settings: ClaudeCodeSettings }).settings;

test("open loads the declared skills as a private plugin that close removes", async () => {
  const opened = await driver().open?.(
    { harness: harnesses.claude({ model: "opus", skills: [skill] }), cwd: worktree },
    context(),
  );
  const settings = openedSettings();
  const plugin = settings.plugins?.[0];
  expect(plugin).toMatchObject({ type: "local", skipMcpDiscovery: true });
  expect(existsSync(path.join(plugin?.path ?? "", "skills", "snowflake", "SKILL.md"))).toBe(true);
  expect(settings.settingSources).toEqual(["project"]);
  expect(settings.strictMcpConfig).toBe(true);
  expect(settings.skills).toBeUndefined();

  await opened?.close();
  expect(readdirSync(path.join(pluginBase, "wrun_skills"))).toEqual([]);
});

test("the plugin lives in a per-run folder recorded as the run's claude-plugins resource", async () => {
  vi.stubEnv("XDG_DATA_HOME", tmp);
  const runFolder = path.join(tmp, "jigs", "claude-plugins", "wrun_skills");
  const opened = await createClaudeDriver({
    sessionMessages: async () => [{ type: "user" }],
  }).open?.(
    { harness: harnesses.claude({ model: "opus", skills: [skill] }), cwd: worktree },
    context(),
  );

  expect(registry.recordRunDirectory).toHaveBeenCalledWith(
    "claude-plugins",
    "wrun_skills",
    runFolder,
  );
  expect(path.dirname(openedSettings().plugins?.[0]?.path ?? "")).toBe(runFolder);
  await opened?.close();
  expect(readdirSync(runFolder)).toEqual([]);
});

test("open without skills builds no plugin", async () => {
  const opened = await driver().open?.(
    { harness: harnesses.claude({ model: "opus" }), cwd: worktree },
    context(),
  );
  expect(openedSettings().plugins).toBeUndefined();
  await opened?.close();
  expect(existsSync(pluginBase)).toBe(false);
});

test("a failed open removes the plugin it built", async () => {
  await expect(
    driver().open?.(
      {
        harness: harnesses.claude({ model: "opus", skills: [skill] }),
        cwd: path.join(tmp, "missing"),
      },
      context(),
    ),
  ).rejects.toThrow();
  expect(readdirSync(path.join(pluginBase, "wrun_skills"))).toEqual([]);
});

test("ask builds no plugin even when the descriptor declares skills", async () => {
  const generateText = vi.fn(async ({ model }: { model: unknown }) => {
    expect(settingsOf(model).plugins).toBeUndefined();
    return { text: "hi" };
  });
  await driver().ask?.(
    buildAskAgentRequest({
      harness: harnesses.claude({ model: "opus", skills: [skill] }),
      prompt: "hi",
    }),
    { ...context(), deps: { generateText, evaluate: vi.fn() } as never },
  );
  expect(generateText).toHaveBeenCalledOnce();
  expect(existsSync(pluginBase)).toBe(false);
});
