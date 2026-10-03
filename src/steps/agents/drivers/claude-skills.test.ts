import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harnesses } from "../../../workflow/agents/harness-config.ts";
import { buildAskAgentRequest } from "../../../workflow/agents/plan.ts";
import { prepareClaudeSkillsPlugin } from "../harnesses/skills.ts";
import { makeTmpDir, removeTmpDir } from "../harnesses/test-fixtures.ts";
import { createClaudeDriver } from "./claude.ts";

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

const driver = () =>
  createClaudeDriver({
    sessionMessages: async () => [{ type: "user" }],
    prepareSkillsPlugin: (runId, skills) =>
      prepareClaudeSkillsPlugin(runId, skills, { baseDir: pluginBase }),
  });
const context = () => ({
  metadata: { workflowRunId: "wrun_skills" },
  env: {},
  signal: new AbortController().signal,
});
const settingsOf = (model: unknown) => (model as { settings: ClaudeCodeSettings }).settings;

test("open loads the declared skills as a private plugin that close removes", async () => {
  const opened = await driver().open?.(
    { harness: harnesses.claude({ model: "opus", skills: [skill] }), cwd: worktree },
    context(),
  );
  const settings = settingsOf(opened?.model);
  const plugin = settings.plugins?.[0];
  expect(plugin).toMatchObject({ type: "local", skipMcpDiscovery: true });
  expect(existsSync(path.join(plugin?.path ?? "", "skills", "snowflake", "SKILL.md"))).toBe(true);
  expect(settings.settingSources).toEqual(["project"]);
  expect(settings.strictMcpConfig).toBe(true);
  expect(settings.skills).toBeUndefined();

  await opened?.close();
  expect(readdirSync(pluginBase)).toEqual([]);
});

test("open without skills builds no plugin", async () => {
  const opened = await driver().open?.(
    { harness: harnesses.claude({ model: "opus" }), cwd: worktree },
    context(),
  );
  expect(settingsOf(opened?.model).plugins).toBeUndefined();
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
  expect(readdirSync(pluginBase)).toEqual([]);
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
