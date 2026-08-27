import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ClaudeCodeSettings,
  PermissionMode,
} from "ai-sdk-provider-claude-code";
import type {
  CodexAppServerProvider,
  CodexAppServerSettings,
  CodexExecSettings,
} from "ai-sdk-provider-codex-cli";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { makeTmpDir, removeTmpDir } from "../harnesses/test-fixtures.ts";
import { claude, codex } from "./config.ts";
import {
  type ExecuteDeps,
  executeAgentStep,
  executeAskStep,
} from "./execute.ts";
import { buildAgentWire, buildAskWire } from "./plan.ts";
import type { StepUsage } from "./result.ts";

const usage = { inputTokens: 12, outputTokens: 34 } as unknown as StepUsage;

let tmp: string;
// The claude provider validates cwd existence at model construction.
let worktree: string;
const savedClaudeExecutable = process.env.JIGS_CLAUDE_EXECUTABLE;
beforeAll(() => {
  tmp = makeTmpDir();
  worktree = path.join(tmp, "worktree");
  mkdirSync(worktree);
  process.env.JIGS_CLAUDE_EXECUTABLE = "/fake/claude";
});
afterAll(() => {
  removeTmpDir(tmp);
  if (savedClaudeExecutable === undefined) {
    delete process.env.JIGS_CLAUDE_EXECUTABLE;
  } else {
    process.env.JIGS_CLAUDE_EXECUTABLE = savedClaudeExecutable;
  }
});

type Captured = {
  options?: Parameters<ExecuteDeps["generateText"]>[0];
  codexModel?: string;
  codexSettings?: CodexAppServerSettings;
  homeRunKeys: string[];
};

function makeDeps(
  generation: Partial<Awaited<ReturnType<ExecuteDeps["generateText"]>>> = {},
): { deps: ExecuteDeps; captured: Captured } {
  const captured: Captured = { homeRunKeys: [] };
  const deps: ExecuteDeps = {
    generateText: async (options) => {
      captured.options = options;
      return { text: "done", files: [], usage, ...generation };
    },
    ensureCodexHome: (runKey) => {
      captured.homeRunKeys.push(runKey);
      return path.join(tmp, "codex-home", runKey);
    },
    withCodexAppServer: async (fn) => {
      const provider = ((modelId: string, settings: CodexAppServerSettings) => {
        captured.codexModel = modelId;
        captured.codexSettings = settings;
        return { fake: "codex-model" };
      }) as unknown as CodexAppServerProvider;
      return fn(provider);
    },
  };
  return { deps, captured };
}

function claudeSettingsOf(captured: Captured): ClaudeCodeSettings {
  const model = captured.options?.model as { settings?: ClaudeCodeSettings };
  const settings = model.settings;
  if (settings === undefined) throw new Error("no claude settings captured");
  return settings;
}

const verdict = z.object({ ok: z.boolean() });

test("claude agent step hydrates from wire config with the harness invariants forced", async () => {
  const wire = buildAgentWire({
    harness: claude({
      model: "sonnet",
      mcpServers: {
        probe: { command: "node", args: ["p.mjs"], env: { T: "1" } },
        remote: { url: "https://mcp.example", headers: { a: "b" } },
      },
    }),
    cwd: worktree,
    prompt: "implement it",
    instructions: "follow the brief",
    permissionMode: "bypassPermissions" as PermissionMode,
  });
  const { deps, captured } = makeDeps();

  await executeAgentStep(wire, "run-1", deps);

  const settings = claudeSettingsOf(captured);
  expect(settings.cwd).toBe(worktree);
  expect(settings.strictMcpConfig).toBe(true);
  expect(settings.settingSources).toEqual(["project"]);
  expect(settings.permissionMode).toBe("bypassPermissions");
  expect(settings.mcpServers).toEqual({
    probe: { type: "stdio", command: "node", args: ["p.mjs"], env: { T: "1" } },
    remote: { type: "http", url: "https://mcp.example", headers: { a: "b" } },
  });
  expect(captured.options?.system).toBe("follow the brief");
  expect(captured.homeRunKeys).toEqual([]);
});

test("codex agent step runs on the app-server under the managed home with fixed policies", async () => {
  const wire = buildAgentWire({
    harness: codex({
      model: "gpt-5.5",
      mcpServers: { probe: { command: "node" } },
    }),
    cwd: worktree,
    prompt: "implement it",
  });
  const { deps, captured } = makeDeps();

  await executeAgentStep(wire, "run-7", deps);

  expect(captured.codexModel).toBe("gpt-5.5");
  const settings = captured.codexSettings;
  expect(settings?.cwd).toBe(worktree);
  expect(settings?.threadMode).toBe("persistent");
  expect(settings?.approvalPolicy).toBe("never");
  expect(settings?.sandboxPolicy).toBe("workspace-write");
  expect(settings?.autoApprove).toBe(true);
  expect(settings?.env?.CODEX_HOME).toBe(path.join(tmp, "codex-home", "run-7"));
  expect(settings?.mcpServers).toEqual({
    probe: { transport: "stdio", command: "node" },
  });
  expect(captured.homeRunKeys).toEqual(["run-7"]);
});

test("a declared output schema becomes an AI SDK output spec and the raw output is returned", async () => {
  const wire = buildAgentWire({
    harness: claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "judge it",
    output: verdict,
  });
  const { deps, captured } = makeDeps({ output: { ok: true } });

  const result = await executeAgentStep(wire, "run-1", deps);

  expect(captured.options?.output).toBeDefined();
  expect(result.output).toEqual({ ok: true });
});

test("without an output schema no output spec is passed and output is undefined", async () => {
  const wire = buildAgentWire({
    harness: claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "just do it",
  });
  const { deps, captured } = makeDeps({ output: "should not surface" });

  const result = await executeAgentStep(wire, "run-1", deps);

  expect(captured.options?.output).toBeUndefined();
  expect(result.output).toBeUndefined();
});

test("usage passes through and the Claude session pointer is captured", async () => {
  const wire = buildAgentWire({
    harness: claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "go",
  });
  const { deps } = makeDeps({
    providerMetadata: { "claude-code": { sessionId: "s-42" } },
  });

  const result = await executeAgentStep(wire, "run-1", deps);

  expect(result.usage).toEqual(usage);
  expect(result.session).toEqual({ harness: "claude", id: "s-42" });
});

test("the Codex threadId is captured, and a missing pointer is omitted, never an error", async () => {
  const codexWire = buildAgentWire({
    harness: codex({ model: "gpt-5.5" }),
    cwd: worktree,
    prompt: "go",
  });

  const withThread = makeDeps({
    providerMetadata: { "codex-app-server": { threadId: "t-7" } },
  });
  const threaded = await executeAgentStep(codexWire, "run-1", withThread.deps);
  expect(threaded.session).toEqual({ harness: "codex", id: "t-7" });

  const bare = makeDeps();
  const sessionless = await executeAgentStep(codexWire, "run-1", bare.deps);
  expect(sessionless.session).toBeUndefined();
  expect("session" in sessionless).toBe(false);
});

test("the step env is a scrubbed copy: no API credentials, process.env untouched", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-scrub";
  try {
    const wire = buildAgentWire({
      harness: claude({ model: "sonnet" }),
      cwd: worktree,
      prompt: "go",
    });
    const { deps, captured } = makeDeps();

    await executeAgentStep(wire, "run-1", deps);

    expect(claudeSettingsOf(captured).env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-test-scrub");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("claude ask step sees no MCP universe and loads no filesystem settings", async () => {
  const wire = buildAskWire({
    harness: claude({ model: "sonnet" }),
    prompt: "summarize",
    system: "be terse",
  });
  const { deps, captured } = makeDeps();

  await executeAskStep(wire, "run-1", deps);

  const settings = claudeSettingsOf(captured);
  expect(settings.strictMcpConfig).toBe(true);
  expect(settings.mcpServers).toEqual({});
  expect(settings.settingSources).toEqual([]);
  expect(settings.cwd).toBeUndefined();
  expect(captured.options?.system).toBe("be terse");
});

test("codex ask step uses read-only exec in a scratch cwd it cleans up", async () => {
  const wire = buildAskWire({
    harness: codex({ model: "gpt-5.5" }),
    prompt: "what is 2+2?",
  });
  const { deps, captured } = makeDeps();

  const result = await executeAskStep(wire, "run-9", deps);

  const model = captured.options?.model as { settings?: CodexExecSettings };
  const settings = model.settings;
  expect(settings?.sandboxMode).toBe("read-only");
  expect(settings?.approvalMode).toBe("never");
  expect(settings?.skipGitRepoCheck).toBe(true);
  expect(settings?.env?.CODEX_HOME).toBe(path.join(tmp, "codex-home", "run-9"));
  expect(settings?.cwd?.startsWith(path.join(tmpdir(), "jigs-ask-"))).toBe(
    true,
  );
  expect(existsSync(settings?.cwd ?? "")).toBe(false);
  expect(result.text).toBe("done");
  expect("session" in result).toBe(false);
});
