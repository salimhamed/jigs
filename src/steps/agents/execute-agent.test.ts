import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import type {
  CodexAppServerProvider,
  CodexAppServerSettings,
  CodexExecSettings,
} from "ai-sdk-provider-codex-cli";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { z } from "zod";
import { unwrapAgentStep } from "../../blocks/agents/agent.ts";
import { harnesses, models } from "../../blocks/agents/harness-config.ts";
import {
  buildAgentRequest,
  buildAskAgentRequest,
  parseOutput,
  type RunAgentOptions,
} from "../../blocks/agents/plan.ts";
import type { AgentResult, ModelUsage } from "../../blocks/agents/result.ts";
import { type RunAgentFn, resumeOrRebuild } from "../../blocks/agents/resume-or-rebuild.ts";
import { drivers } from "./drivers/index.ts";
import { type AgentExecutionDependencies, executeAgent } from "./execute-agent.ts";
import type { PiExecutionOptions } from "./harnesses/pi.ts";
import { makeTmpDir, removeTmpDir } from "./harnesses/test-fixtures.ts";

// The settings look for the CLI eagerly, so these tests would need a codex
// installed. Claude's half is stubbed below, through JIGS_CLAUDE_EXECUTABLE.
vi.mock("./harnesses/executables.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./harnesses/executables.ts")>()),
  resolveCodexExecutable: () => "/fake/codex",
}));

const usage = { inputTokens: 12, outputTokens: 34 } as unknown as ModelUsage;

let tmp: string;
// The claude provider validates cwd existence at model construction.
let worktree: string;
const savedClaudeExecutable = process.env.JIGS_CLAUDE_EXECUTABLE;
// The agent step takes a lock under the jigs data dir; nothing here may write
// to the real one.
const savedDataHome = process.env.XDG_DATA_HOME;
beforeAll(() => {
  tmp = makeTmpDir();
  worktree = path.join(tmp, "worktree");
  mkdirSync(worktree);
  process.env.JIGS_CLAUDE_EXECUTABLE = "/fake/claude";
  process.env.XDG_DATA_HOME = path.join(tmp, "data");
});
afterAll(() => {
  removeTmpDir(tmp);
  if (savedClaudeExecutable === undefined) {
    delete process.env.JIGS_CLAUDE_EXECUTABLE;
  } else {
    process.env.JIGS_CLAUDE_EXECUTABLE = savedClaudeExecutable;
  }
  if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedDataHome;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Captured = {
  options?: Parameters<AgentExecutionDependencies["generateText"]>[0];
  codexModel?: string;
  codexSettings?: CodexAppServerSettings;
  homeRunIds: string[];
  piOptions?: PiExecutionOptions;
  piHome?: { runId: string; model: unknown };
};

function makeDeps(
  generation: Partial<Awaited<ReturnType<AgentExecutionDependencies["generateText"]>>> = {},
): {
  deps: AgentExecutionDependencies;
  captured: Captured;
} {
  const captured: Captured = { homeRunIds: [] };
  const deps: AgentExecutionDependencies = {
    generateText: async (options) => {
      captured.options = options;
      return { text: "done", usage, ...generation };
    },
    ensureCodexHome: (runId) => {
      captured.homeRunIds.push(runId);
      return path.join(tmp, "codex-home", runId);
    },
    ensurePiHome: (runId, model) => {
      captured.piHome = { runId, model };
      const home = path.join(tmp, "pi-home", runId);
      mkdirSync(path.join(home, "sessions"), { recursive: true });
      return home;
    },
    executePi: async (options) => {
      captured.piOptions = options;
      return { text: "done", usage, ...generation };
    },
    // The probe itself is covered in ./jit-marker.test.ts, against a server
    // that really cannot start.
    jitFailures: async () => undefined,
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

// executeAgent answers a union; every test but the resume-failure ones wants the
// successful arm.
async function agentStep(...args: Parameters<typeof executeAgent>): Promise<AgentResult<unknown>> {
  const result = await executeAgent(...args);
  if ("jitFailure" in result) {
    throw new Error(`unexpected JIT failure: ${JSON.stringify(result.jitFailure)}`);
  }
  if ("resumeFailed" in result) {
    throw new Error(`unexpected resume failure: ${result.resumeFailed}`);
  }
  return result;
}

function claudeSettingsOf(captured: Captured): ClaudeCodeSettings {
  const model = captured.options?.model as { settings?: ClaudeCodeSettings };
  const settings = model.settings;
  if (settings === undefined) throw new Error("no claude settings captured");
  return settings;
}

const verdict = z.object({ ok: z.boolean() });

test("claude agent step hydrates from wire config with the harness invariants forced", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude("sonnet", {
      effort: "medium",
      mcpServers: {
        probe: {
          command: "node",
          args: ["p.mjs"],
          env: { T: "1" },
          probe: { tool: "ping" },
        },
        remote: {
          url: "https://mcp.example",
          headers: { a: "b" },
          probe: { tool: "ping" },
        },
      },
    }),
    cwd: worktree,
    prompt: "implement it",
  });
  const { deps, captured } = makeDeps();

  await agentStep(wire, { workflowRunId: "run-1" }, deps);

  const settings = claudeSettingsOf(captured);
  expect(settings.cwd).toBe(worktree);
  expect(settings.strictMcpConfig).toBe(true);
  expect(settings.settingSources).toEqual(["project"]);
  expect(settings.effort).toBe("medium");
  expect(settings.mcpServers).toEqual({
    probe: { type: "stdio", command: "node", args: ["p.mjs"], env: { T: "1" } },
    remote: { type: "http", url: "https://mcp.example", headers: { a: "b" } },
  });
  expect(captured.options?.system).toBeUndefined();
  expect(captured.homeRunIds).toEqual([]);
});

test("codex agent step runs on the app-server under the managed home with fixed policies", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.codex("gpt-5.5", {
      effort: "xhigh",
      mcpServers: { probe: { command: "node", probe: { tool: "ping" } } },
    }),
    cwd: worktree,
    prompt: "implement it",
  });
  const { deps, captured } = makeDeps();

  await agentStep(wire, { workflowRunId: "run-7" }, deps);

  expect(captured.codexModel).toBe("gpt-5.5");
  const settings = captured.codexSettings;
  expect(settings?.cwd).toBe(worktree);
  expect(settings?.threadMode).toBe("persistent");
  expect(settings?.approvalPolicy).toBe("never");
  expect(settings?.sandboxPolicy).toBe("danger-full-access");
  expect(settings?.autoApprove).toBe(true);
  expect(settings?.effort).toBe("xhigh");
  expect(settings?.env?.CODEX_HOME).toBe(path.join(tmp, "codex-home", "run-7"));
  expect(settings?.mcpServers).toEqual({
    probe: { transport: "stdio", command: "node" },
  });
  expect(captured.homeRunIds).toEqual(["run-7"]);
});

test("omitting effort leaves both providers' settings unset", async () => {
  const claudeRun = makeDeps();
  await agentStep(
    buildAgentRequest({
      harness: harnesses.claude("sonnet"),
      cwd: worktree,
      prompt: "implement it",
    }),
    { workflowRunId: "run-1" },
    claudeRun.deps,
  );
  expect("effort" in claudeSettingsOf(claudeRun.captured)).toBe(false);

  const codexRun = makeDeps();
  await agentStep(
    buildAgentRequest({
      harness: harnesses.codex("gpt-5.5"),
      cwd: worktree,
      prompt: "implement it",
    }),
    { workflowRunId: "run-1" },
    codexRun.deps,
  );
  expect(codexRun.captured.codexSettings).not.toHaveProperty("effort");
});

test("a declared output schema becomes an AI SDK output spec and the raw output is returned", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude("sonnet"),
    cwd: worktree,
    prompt: "judge it",
    output: verdict,
  });
  const { deps, captured } = makeDeps({ output: { ok: true } });

  const result = await agentStep(wire, { workflowRunId: "run-1" }, deps);

  expect(captured.options?.output).toBeDefined();
  expect(result.output).toEqual({ ok: true });
});

test("without an output schema no output spec is passed and output is undefined", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude("sonnet"),
    cwd: worktree,
    prompt: "just do it",
  });
  const { deps, captured } = makeDeps({ output: "should not surface" });

  const result = await agentStep(wire, { workflowRunId: "run-1" }, deps);

  expect(captured.options?.output).toBeUndefined();
  expect(result.output).toBeUndefined();
});

test("usage passes through and the Claude session pointer is captured", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude("sonnet"),
    cwd: worktree,
    prompt: "go",
  });
  const { deps } = makeDeps({
    providerMetadata: { "claude-code": { sessionId: "s-42" } },
  });

  const result = await agentStep(wire, { workflowRunId: "run-1" }, deps);

  expect(result.usage).toEqual(usage);
  expect(result.session).toEqual({ harness: "claude", id: "s-42" });
});

test("the Codex threadId is captured, and a missing pointer is omitted, never an error", async () => {
  const codexWire = buildAgentRequest({
    harness: harnesses.codex("gpt-5.5"),
    cwd: worktree,
    prompt: "go",
  });

  const withThread = makeDeps({
    providerMetadata: { "codex-app-server": { threadId: "t-7" } },
  });
  const threaded = await agentStep(codexWire, { workflowRunId: "run-1" }, withThread.deps);
  expect(threaded.session).toEqual({ harness: "codex", id: "t-7" });

  const bare = makeDeps();
  const sessionless = await agentStep(codexWire, { workflowRunId: "run-1" }, bare.deps);
  expect(sessionless.session).toBeUndefined();
  expect("session" in sessionless).toBe(false);
});

test("a claude resume rides on the settings' resume field", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude("sonnet"),
    cwd: worktree,
    prompt: "answer the review",
    resume: { harness: "claude", id: "s-42" },
  });
  const { deps, captured } = makeDeps();

  await agentStep(wire, { workflowRunId: "run-1" }, deps);

  expect(claudeSettingsOf(captured).resume).toBe("s-42");
  expect(captured.options?.providerOptions).toBeUndefined();
});

test("a codex resume rides on providerOptions['codex-app-server'].threadId", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.codex("gpt-5.5"),
    cwd: worktree,
    prompt: "answer the review",
    resume: { harness: "codex", id: "0199-thread" },
  });
  const { deps, captured } = makeDeps();

  await agentStep(wire, { workflowRunId: "run-1" }, deps);

  expect(captured.options?.providerOptions).toEqual({
    "codex-app-server": { threadId: "0199-thread" },
  });
  // settings.resume is the provider's fallback, not the app-server contract.
  expect(captured.codexSettings?.resume).toBeUndefined();
});

test("a session pointer recorded on the other harness reports resumeFailed, not a silently fresh session", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude("sonnet"),
    cwd: worktree,
    prompt: "answer the review",
    resume: { harness: "codex", id: "0199-thread" },
  });
  const { deps, captured } = makeDeps();

  const result = await executeAgent(wire, { workflowRunId: "run-1" }, deps);

  // The resume prompt was written for an agent that already holds the change,
  // so running it against a brand-new session would be a lie. The marker sends
  // the caller down the same rebuild path a stale pointer does.
  expect(result).toEqual({
    resumeFailed: expect.stringContaining("recorded on the codex harness"),
  });
  expect(captured.options).toBeUndefined();
});

test("Claude steps always run with bypass", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude("sonnet"),
    cwd: worktree,
    prompt: "judge it",
  });
  const { deps, captured } = makeDeps();

  await agentStep(wire, { workflowRunId: "run-1" }, deps);

  const settings = claudeSettingsOf(captured);
  expect(settings.permissionMode).toBe("bypassPermissions");
  expect(settings.allowDangerouslySkipPermissions).toBe(true);
});

test("a failed resume returns the resumeFailed marker instead of throwing", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.codex("gpt-5.5"),
    cwd: worktree,
    prompt: "answer the review",
    resume: { harness: "codex", id: "0199-gone" },
  });
  const { deps } = makeDeps();
  // The raw JSON-RPC error codex 0.149.1 actually raises — it matches no
  // wrapper the provider documents, which is why any error reads as stale.
  deps.generateText = () => {
    throw new Error("no rollout found for thread id 0199-gone");
  };

  const result = await executeAgent(wire, { workflowRunId: "run-1" }, deps);

  expect(result).toEqual({
    resumeFailed: expect.stringContaining("no rollout found for thread id"),
  });
});

test("a failure with no resume to blame still throws", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude("sonnet"),
    cwd: worktree,
    prompt: "go",
  });
  const { deps } = makeDeps();
  deps.generateText = () => {
    throw new Error("the harness fell over");
  };

  await expect(executeAgent(wire, { workflowRunId: "run-1" }, deps)).rejects.toThrow(
    "the harness fell over",
  );
});

test("a second agent in the same worktree is refused while the first is running", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude("sonnet"),
    cwd: worktree,
    prompt: "implement it",
  });
  let releaseFirst = () => {};
  const first = makeDeps();
  first.deps.generateText = async () => {
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    return { text: "done", usage };
  };

  const inFlight = agentStep(wire, { workflowRunId: "run-1" }, first.deps);
  // Yield so the first call is inside the lock before the second tries.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const second = makeDeps();
  await expect(executeAgent(wire, { workflowRunId: "run-1" }, second.deps)).rejects.toThrow(
    /an agent is already running in .* refusing to start a second one/,
  );
  expect(second.captured.options).toBeUndefined();

  releaseFirst();
  await inFlight;

  // Released, so the worktree takes the next agent step normally.
  const after = makeDeps();
  await agentStep(wire, { workflowRunId: "run-1" }, after.deps);
  expect(after.captured.options?.prompt).toBe("implement it");
});

test("a busy worktree does not block an agent in another one", async () => {
  const other = path.join(tmp, "worktree-2");
  mkdirSync(other, { recursive: true });
  let releaseFirst = () => {};
  const first = makeDeps();
  first.deps.generateText = async () => {
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    return { text: "done", usage };
  };

  const inFlight = agentStep(
    buildAgentRequest({
      harness: harnesses.claude("sonnet"),
      cwd: worktree,
      prompt: "implement it",
    }),
    { workflowRunId: "run-1" },
    first.deps,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  const elsewhere = makeDeps();
  await agentStep(
    buildAgentRequest({
      harness: harnesses.claude("sonnet"),
      cwd: other,
      prompt: "implement it elsewhere",
    }),
    { workflowRunId: "run-1" },
    elsewhere.deps,
  );
  expect(elsewhere.captured.options?.prompt).toBe("implement it elsewhere");

  releaseFirst();
  await inFlight;
});

test("the step env is a scrubbed copy: no API credentials, process.env untouched", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-scrub";
  try {
    const wire = buildAgentRequest({
      harness: harnesses.claude("sonnet"),
      cwd: worktree,
      prompt: "go",
    });
    const { deps, captured } = makeDeps();

    await agentStep(wire, { workflowRunId: "run-1" }, deps);

    expect(claudeSettingsOf(captured).env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-test-scrub");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("a failed JIT check returns the marker before the harness is reached", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude("sonnet"),
    cwd: worktree,
    prompt: "never reached — the JIT check fails first",
  });
  const { deps, captured } = makeDeps();

  const failures = [
    {
      ok: false as const,
      id: "mcp:linear",
      label: "MCP server 'linear'",
      reason: "it did not start",
      repair: "check the command",
    },
  ];

  const result = await executeAgent(
    wire,
    { workflowRunId: "run-1" },
    {
      ...deps,
      jitFailures: async () => failures,
    },
  );

  expect(result).toEqual({ jitFailure: failures });
  expect(captured.options).toBeUndefined();
});

test("claude ask step sees no MCP universe and loads no filesystem settings", async () => {
  const wire = buildAskAgentRequest({
    harness: harnesses.claude("sonnet"),
    prompt: "summarize",
    system: "be terse",
  });
  const { deps, captured } = makeDeps();

  await agentStep(wire, { workflowRunId: "run-1" }, deps);

  const settings = claudeSettingsOf(captured);
  expect(settings.strictMcpConfig).toBe(true);
  expect(settings.mcpServers).toEqual({});
  expect(settings.settingSources).toEqual([]);
  expect(settings.cwd).toBeUndefined();
  expect(captured.options?.system).toBe("be terse");
});

test("codex ask step uses read-only exec in a scratch cwd it cleans up", async () => {
  const wire = buildAskAgentRequest({
    harness: harnesses.codex("gpt-5.5"),
    prompt: "what is 2+2?",
  });
  const { deps, captured } = makeDeps();

  const result = await agentStep(wire, { workflowRunId: "run-9" }, deps);

  const model = captured.options?.model as { settings?: CodexExecSettings };
  const settings = model.settings;
  expect(settings?.sandboxMode).toBe("read-only");
  expect(settings?.approvalMode).toBe("never");
  expect(settings?.skipGitRepoCheck).toBe(true);
  expect(settings?.env?.CODEX_HOME).toBe(path.join(tmp, "codex-home", "run-9"));
  expect(settings?.cwd?.startsWith(path.join(tmpdir(), "jigs-ask-"))).toBe(true);
  expect(existsSync(settings?.cwd ?? "")).toBe(false);
  expect(result.text).toBe("done");
  expect("session" in result).toBe(false);
});

test("pi ask executes its nested model with isolated discovery and returns executor output", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ data: [{ id: "local-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const source = models.openaiCompatible({
    name: "studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
  });
  const wire = buildAskAgentRequest({
    harness: harnesses.pi(source, { thinking: "medium" }),
    prompt: "judge it",
    output: verdict,
  });
  const { deps, captured } = makeDeps({
    output: { ok: true },
    providerMetadata: { pi: { sessionId: "pi-session", costUsd: 0.25 } },
  });

  const result = await agentStep(wire, { workflowRunId: "run-pi" }, deps);

  expect(captured.piHome).toEqual({ runId: "run-pi", model: source });
  expect(captured.piOptions?.args).toEqual([
    "--mode",
    "json",
    "--no-tools",
    "--model",
    "studio/local-model",
    "--thinking",
    "medium",
    "-ne",
    "-ns",
    "-np",
    "--no-themes",
    "-nc",
    "--no-approve",
    "-e",
    expect.stringContaining("submit-result.ts"),
    expect.stringContaining("Call submit_result"),
  ]);
  expect(captured.piOptions?.env.PI_CODING_AGENT_DIR).toBe(path.join(tmp, "pi-home", "run-pi"));
  expect(existsSync(captured.piOptions?.cwd ?? "")).toBe(false);
  expect(result).toEqual({
    text: "done",
    output: { ok: true },
    usage: { ...usage, costUsd: 0.25 },
  });
});

test("pi ask rejects an unreachable nested endpoint before executing Pi", async () => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("connection refused");
  });
  const actualRuntimeChecks = drivers.pi.runtimeChecks;
  vi.spyOn(drivers.pi, "runtimeChecks").mockImplementation((request) =>
    actualRuntimeChecks(request).filter((check) => check.id === "model.openai-compatible-runtime"),
  );
  const { deps, captured } = makeDeps();
  const wire = buildAskAgentRequest({
    harness: harnesses.pi(
      models.openaiCompatible({
        name: "offline-studio",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "local-model",
      }),
    ),
    prompt: "hello",
  });

  await expect(executeAgent(wire, { workflowRunId: "run-pi" }, deps)).rejects.toThrow(
    /offline-studio model endpoint: offline-studio is unreachable/,
  );
  expect(captured.piOptions).toBeUndefined();
});

test("pi ask rejects missing nested authentication before executing Pi", async () => {
  vi.spyOn(drivers.pi, "runtimeChecks").mockReturnValue([]);
  vi.stubEnv("PI_TEST_OPENROUTER_KEY", "");
  const { deps, captured } = makeDeps();
  const wire = buildAskAgentRequest({
    harness: harnesses.pi(
      models.openrouter("openai/gpt-oss", { apiKeyEnv: "PI_TEST_OPENROUTER_KEY" }),
    ),
    prompt: "hello",
  });

  await expect(executeAgent(wire, { workflowRunId: "run-pi" }, deps)).rejects.toThrow(
    /PI_TEST_OPENROUTER_KEY credential: PI_TEST_OPENROUTER_KEY is not set/,
  );
  expect(captured.piOptions).toBeUndefined();
});

test("pi run mints and records a matching session with tools in the worktree", async () => {
  vi.spyOn(drivers.pi, "runtimeChecks").mockReturnValue([]);
  vi.spyOn(drivers.pi, "authChecks").mockReturnValue([]);
  const source = models.openaiCompatible({
    name: "studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
  });
  const wire = buildAgentRequest({
    harness: harnesses.pi(source, { thinking: "high", tools: ["read", "bash"] }),
    cwd: worktree,
    prompt: "implement it",
    output: verdict,
  });
  const { deps, captured } = makeDeps({ output: { ok: true } });
  deps.executePi = async (options) => {
    captured.piOptions = options;
    const id = options.args[options.args.indexOf("--session-id") + 1];
    return {
      text: "done",
      output: { ok: true },
      usage,
      providerMetadata: { pi: { sessionId: id } },
    };
  };

  const result = await agentStep(wire, { workflowRunId: "run-pi-worktree" }, deps);

  const args = captured.piOptions?.args ?? [];
  const sessionId = args[args.indexOf("--session-id") + 1];
  expect(sessionId).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
  expect(args).toContain("--tools");
  expect(args[args.indexOf("--tools") + 1]).toBe("read,bash");
  expect(args).not.toContain("--no-tools");
  expect(args[args.indexOf("--session-dir") + 1]).toBe(
    path.join(tmp, "pi-home", "run-pi-worktree", "sessions"),
  );
  expect(captured.piOptions?.cwd).toBe(worktree);
  expect(result.session).toEqual({ harness: "pi", id: sessionId });
  expect(result.output).toEqual({ ok: true });
});

test("pi run returns a stale resume marker before spawning Pi", async () => {
  vi.spyOn(drivers.pi, "runtimeChecks").mockReturnValue([]);
  vi.spyOn(drivers.pi, "authChecks").mockReturnValue([]);
  const wire = buildAgentRequest({
    harness: harnesses.pi(models.openrouter("openai/gpt-oss")),
    cwd: worktree,
    prompt: "continue",
    resume: { harness: "pi", id: "missing-session" },
  });
  const { deps, captured } = makeDeps();

  const result = await executeAgent(wire, { workflowRunId: "run-pi-stale" }, deps);

  expect(result).toEqual({
    resumeFailed: expect.stringMatching(/missing-session.*run-pi-stale\/sessions/),
  });
  expect(captured.piOptions).toBeUndefined();
});

test("pi run resumes only after finding the real session file", async () => {
  vi.spyOn(drivers.pi, "runtimeChecks").mockReturnValue([]);
  vi.spyOn(drivers.pi, "authChecks").mockReturnValue([]);
  const sessionId = "existing-session";
  const source = models.openrouter("openai/gpt-oss");
  const wire = buildAgentRequest({
    harness: harnesses.pi(source),
    cwd: worktree,
    prompt: "continue",
    resume: { harness: "pi", id: sessionId },
  });
  const { deps, captured } = makeDeps();
  const home = deps.ensurePiHome("run-pi-resume", source);
  writeFileSync(path.join(home, "sessions", `2026-09-21T00-00-00_${sessionId}.jsonl`), "");
  deps.executePi = async (options) => {
    captured.piOptions = options;
    return { text: "continued", usage, providerMetadata: { pi: { sessionId } } };
  };

  const result = await agentStep(wire, { workflowRunId: "run-pi-resume" }, deps);

  expect(captured.piOptions?.args).toContain(sessionId);
  expect(result.session).toEqual({ harness: "pi", id: sessionId });
});

test("pi run rejects a different session id reported by Pi", async () => {
  vi.spyOn(drivers.pi, "runtimeChecks").mockReturnValue([]);
  vi.spyOn(drivers.pi, "authChecks").mockReturnValue([]);
  const wire = buildAgentRequest({
    harness: harnesses.pi(models.openrouter("openai/gpt-oss")),
    cwd: worktree,
    prompt: "implement it",
  });
  const { deps } = makeDeps();
  deps.executePi = async () => ({
    text: "done",
    usage,
    providerMetadata: { pi: { sessionId: "different-session" } },
  });

  await expect(executeAgent(wire, { workflowRunId: "run-pi-mismatch" }, deps)).rejects.toThrow(
    /Pi reported session.*different-session.*jigs-/,
  );
});

test("pi run leaves Pi's default tools enabled when no allowlist is supplied", async () => {
  vi.spyOn(drivers.pi, "runtimeChecks").mockReturnValue([]);
  vi.spyOn(drivers.pi, "authChecks").mockReturnValue([]);
  const wire = buildAgentRequest({
    harness: harnesses.pi(models.openrouter("openai/gpt-oss")),
    cwd: worktree,
    prompt: "implement it",
  });
  const { deps, captured } = makeDeps();
  deps.executePi = async (options) => {
    captured.piOptions = options;
    const id = options.args[options.args.indexOf("--session-id") + 1];
    return { text: "done", usage, providerMetadata: { pi: { sessionId: id } } };
  };

  await agentStep(wire, { workflowRunId: "run-pi-default-tools" }, deps);

  expect(captured.piOptions?.args).not.toContain("--tools");
  expect(captured.piOptions?.args).not.toContain("--no-tools");
});

test("pi run rejects an unreachable nested endpoint before spawning Pi", async () => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("connection refused");
  });
  const actualRuntimeChecks = drivers.pi.runtimeChecks;
  vi.spyOn(drivers.pi, "runtimeChecks").mockImplementation((request) =>
    actualRuntimeChecks(request).filter((check) => check.id === "model.openai-compatible-runtime"),
  );
  vi.spyOn(drivers.pi, "authChecks").mockReturnValue([]);
  const wire = buildAgentRequest({
    harness: harnesses.pi(
      models.openaiCompatible({
        name: "offline-studio",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "local-model",
      }),
    ),
    cwd: worktree,
    prompt: "implement it",
  });
  const { deps, captured } = makeDeps();

  await expect(executeAgent(wire, { workflowRunId: "run-pi-offline" }, deps)).rejects.toThrow(
    /offline-studio model endpoint: offline-studio is unreachable/,
  );
  expect(captured.piOptions).toBeUndefined();
});

test("pi stale sessions take resumeOrRebuild's fresh arm", async () => {
  vi.spyOn(drivers.pi, "runtimeChecks").mockReturnValue([]);
  vi.spyOn(drivers.pi, "authChecks").mockReturnValue([]);
  const harness = harnesses.pi(models.openrouter("openai/gpt-oss"));
  const { deps } = makeDeps({ output: { ok: true } });
  let spawned = 0;
  deps.executePi = async (options) => {
    spawned += 1;
    const id = options.args[options.args.indexOf("--session-id") + 1];
    return {
      text: "done",
      output: { ok: true },
      usage,
      providerMetadata: { pi: { sessionId: id } },
    };
  };
  const runAgent: RunAgentFn = async <T>(config: RunAgentOptions<T>) => {
    const stepResult = await executeAgent(
      buildAgentRequest(config),
      { workflowRunId: "run-pi-rebuild" },
      deps,
    );
    const result = unwrapAgentStep(stepResult);
    return { ...result, output: parseOutput(config.output, result.output) } as AgentResult<T>;
  };

  const result = await resumeOrRebuild({
    runAgent,
    harness,
    cwd: worktree,
    session: { harness: "pi", id: "gone" },
    resumePrompt: "continue",
    freshPrompt: "start again",
    output: verdict,
    label: "pi-test",
  });

  expect(spawned).toBe(1);
  expect(result.output).toEqual({ ok: true });
  expect(result.session?.harness).toBe("pi");
  expect(result.session?.id).not.toBe("gone");
});

test("pi run honors JIT failure before creating its managed home or spawning", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.pi(models.openrouter("openai/gpt-oss")),
    cwd: worktree,
    prompt: "implement it",
  });
  const { deps, captured } = makeDeps();
  deps.jitFailures = async () => [
    {
      id: "github.marker",
      label: "GitHub marker",
      ok: false,
      reason: "not ready",
      repair: "wait",
    },
  ];

  const result = await executeAgent(wire, { workflowRunId: "run-pi-jit" }, deps);

  expect(result).toEqual({
    jitFailure: [expect.objectContaining({ id: "github.marker", reason: "not ready" })],
  });
  expect(captured.piHome).toBeUndefined();
  expect(captured.piOptions).toBeUndefined();
});
