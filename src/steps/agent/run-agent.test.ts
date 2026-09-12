import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import type {
  CodexAppServerProvider,
  CodexAppServerSettings,
  CodexExecSettings,
} from "ai-sdk-provider-codex-cli";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { claude, codex } from "../../blocks/agent/harness-config.ts";
import { buildAgentWire, buildAskWire } from "../../blocks/agent/plan.ts";
import type { AgentStepResult, StepUsage } from "../../blocks/agent/result.ts";
import { makeTmpDir, removeTmpDir } from "./harnesses/test-fixtures.ts";
import { type ExecuteDeps, runAgent } from "./run-agent.ts";
import { askModel } from "./run-ask.ts";

const usage = { inputTokens: 12, outputTokens: 34 } as unknown as StepUsage;

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

type Captured = {
  options?: Parameters<ExecuteDeps["generateText"]>[0];
  codexModel?: string;
  codexSettings?: CodexAppServerSettings;
  homeRunIds: string[];
};

function makeDeps(generation: Partial<Awaited<ReturnType<ExecuteDeps["generateText"]>>> = {}): {
  deps: ExecuteDeps;
  captured: Captured;
} {
  const captured: Captured = { homeRunIds: [] };
  const deps: ExecuteDeps = {
    generateText: async (options) => {
      captured.options = options;
      return { text: "done", usage, ...generation };
    },
    ensureCodexHome: (runId) => {
      captured.homeRunIds.push(runId);
      return path.join(tmp, "codex-home", runId);
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

// runAgent answers a union; every test but the resume-failure ones wants the
// successful arm.
async function agentStep(...args: Parameters<typeof runAgent>): Promise<AgentStepResult<unknown>> {
  const result = await runAgent(...args);
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
  const wire = buildAgentWire({
    harness: claude({
      model: "sonnet",
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
  expect(settings.mcpServers).toEqual({
    probe: { type: "stdio", command: "node", args: ["p.mjs"], env: { T: "1" } },
    remote: { type: "http", url: "https://mcp.example", headers: { a: "b" } },
  });
  expect(captured.options?.system).toBeUndefined();
  expect(captured.homeRunIds).toEqual([]);
});

test("codex agent step runs on the app-server under the managed home with fixed policies", async () => {
  const wire = buildAgentWire({
    harness: codex({
      model: "gpt-5.5",
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
  expect(settings?.env?.CODEX_HOME).toBe(path.join(tmp, "codex-home", "run-7"));
  expect(settings?.mcpServers).toEqual({
    probe: { transport: "stdio", command: "node" },
  });
  expect(captured.homeRunIds).toEqual(["run-7"]);
});

test("a declared output schema becomes an AI SDK output spec and the raw output is returned", async () => {
  const wire = buildAgentWire({
    harness: claude({ model: "sonnet" }),
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
  const wire = buildAgentWire({
    harness: claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "just do it",
  });
  const { deps, captured } = makeDeps({ output: "should not surface" });

  const result = await agentStep(wire, { workflowRunId: "run-1" }, deps);

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

  const result = await agentStep(wire, { workflowRunId: "run-1" }, deps);

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
  const threaded = await agentStep(codexWire, { workflowRunId: "run-1" }, withThread.deps);
  expect(threaded.session).toEqual({ harness: "codex", id: "t-7" });

  const bare = makeDeps();
  const sessionless = await agentStep(codexWire, { workflowRunId: "run-1" }, bare.deps);
  expect(sessionless.session).toBeUndefined();
  expect("session" in sessionless).toBe(false);
});

test("a claude resume rides on the settings' resume field", async () => {
  const wire = buildAgentWire({
    harness: claude({ model: "sonnet" }),
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
  const wire = buildAgentWire({
    harness: codex({ model: "gpt-5.5" }),
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
  const wire = buildAgentWire({
    harness: claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "answer the review",
    resume: { harness: "codex", id: "0199-thread" },
  });
  const { deps, captured } = makeDeps();

  const result = await runAgent(wire, { workflowRunId: "run-1" }, deps);

  // The resume prompt was written for an agent that already holds the change,
  // so running it against a brand-new session would be a lie. The marker sends
  // the caller down the same rebuild path a stale pointer does.
  expect(result).toEqual({
    resumeFailed: expect.stringContaining("recorded on the codex harness"),
  });
  expect(captured.options).toBeUndefined();
});

test("Claude steps always run with bypass", async () => {
  const wire = buildAgentWire({
    harness: claude({ model: "sonnet" }),
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
  const wire = buildAgentWire({
    harness: codex({ model: "gpt-5.5" }),
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

  const result = await runAgent(wire, { workflowRunId: "run-1" }, deps);

  expect(result).toEqual({
    resumeFailed: expect.stringContaining("no rollout found for thread id"),
  });
});

test("a failure with no resume to blame still throws", async () => {
  const wire = buildAgentWire({
    harness: claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "go",
  });
  const { deps } = makeDeps();
  deps.generateText = () => {
    throw new Error("the harness fell over");
  };

  await expect(runAgent(wire, { workflowRunId: "run-1" }, deps)).rejects.toThrow(
    "the harness fell over",
  );
});

test("a second agent in the same worktree is refused while the first is running", async () => {
  const wire = buildAgentWire({
    harness: claude({ model: "sonnet" }),
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
  await expect(runAgent(wire, { workflowRunId: "run-1" }, second.deps)).rejects.toThrow(
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
    buildAgentWire({
      harness: claude({ model: "sonnet" }),
      cwd: worktree,
      prompt: "implement it",
    }),
    { workflowRunId: "run-1" },
    first.deps,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  const elsewhere = makeDeps();
  await agentStep(
    buildAgentWire({
      harness: claude({ model: "sonnet" }),
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
    const wire = buildAgentWire({
      harness: claude({ model: "sonnet" }),
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
  const wire = buildAgentWire({
    harness: claude({ model: "sonnet" }),
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

  const result = await runAgent(
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
  const wire = buildAskWire({
    harness: claude({ model: "sonnet" }),
    prompt: "summarize",
    system: "be terse",
  });
  const { deps, captured } = makeDeps();

  await askModel(wire, { workflowRunId: "run-1" }, deps);

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

  const result = await askModel(wire, { workflowRunId: "run-9" }, deps);

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
