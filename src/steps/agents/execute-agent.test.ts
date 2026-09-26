import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import type { CodexAppServerProvider, CodexAppServerSettings } from "ai-sdk-provider-codex-cli";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { z } from "zod";
import { unwrapAgentStep } from "../../workflow/agents/agent.ts";
import { bindAgentSession, type RunAgentFn } from "../../workflow/agents/agent-session.ts";
import { type CodexHarness, harnesses, models } from "../../workflow/agents/harness-config.ts";
import {
  buildAgentRequest,
  buildAskAgentRequest,
  parseOutput,
  type RunAgentOptions,
} from "../../workflow/agents/plan.ts";
import type { AgentResult } from "../../workflow/agents/result.ts";
import { createClaudeDriver } from "./drivers/claude.ts";
import { createCodexDriver } from "./drivers/codex.ts";
import { type DriverResolver, driverFor, drivers } from "./drivers/index.ts";
import { createPiDriver, type PiDriverDependencies } from "./drivers/pi.ts";
import { executeAgentWith } from "./execute-agent.ts";
import type { PiExecutionOptions } from "./harnesses/pi.ts";
import { planPiModel } from "./harnesses/pi-model.ts";
import { makeTmpDir, removeTmpDir } from "./harnesses/test-fixtures.ts";
import { type ExecutionSeams, executionSeams } from "./seams.ts";

// The settings look for the CLI eagerly, so these tests would need a codex
// installed. Claude's half is stubbed below, through JIGS_CLAUDE_EXECUTABLE.
vi.mock("./harnesses/executables.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./harnesses/executables.ts")>()),
  resolveCodexExecutable: () => "/fake/codex",
}));

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
  options?: Parameters<ExecutionSeams["generateText"]>[0];
  codexModel?: string;
  codexSettings?: CodexAppServerSettings;
  codexCall?: MockLanguageModelV4["doGenerateCalls"][number];
  homeRunIds: string[];
  piOptions?: PiExecutionOptions;
  piHome?: { runId: string; model: unknown };
};

// Pi's request checks probe the nested model endpoint and credentials, which
// most tests neither stub nor care about; the ones that do opt back in.
function makeDeps(
  generation: Partial<Awaited<ReturnType<ExecutionSeams["generateText"]>>> = {},
  options: { piRequestChecks?: boolean } = {},
): {
  deps: ExecutionSeams;
  captured: Captured;
  piDeps: PiDriverDependencies;
} {
  const captured: Captured = { homeRunIds: [] };
  const generateText: ExecutionSeams["generateText"] = async (options) => {
    captured.options = options;
    return { text: "done", ...generation };
  };
  const preparePiHome: PiDriverDependencies["preparePiHome"] = (runId, model) => {
    captured.piHome = { runId, model };
    const home = path.join(tmp, "pi-home", runId, crypto.randomUUID());
    const sessionDir = path.join(tmp, "pi-home", runId, "sessions");
    mkdirSync(home, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    return { home, sessionDir, cleanup: () => rmSync(home, { recursive: true, force: true }) };
  };
  const piDeps: PiDriverDependencies = {
    preparePiHome,
    executePi: async (options) => {
      captured.piOptions = options;
      return { text: "done", ...generation };
    },
  };
  const testDrivers = {
    ...drivers,
    claude: createClaudeDriver({ sessionMessages: async () => [{ type: "user" }] }),
    codex: createCodexDriver({
      prepareCodexHome: (runId) => {
        captured.homeRunIds.push(runId);
        const home = path.join(tmp, "codex-home", runId, crypto.randomUUID());
        const sessionDir = path.join(tmp, "codex-home", runId, "sessions");
        mkdirSync(home, { recursive: true });
        mkdirSync(sessionDir, { recursive: true });
        return { home, sessionDir, cleanup: () => rmSync(home, { recursive: true, force: true }) };
      },
      sessionFile: (_sessionDir, threadId) => `/rollout-${threadId}.jsonl`,
      createAppServer: () =>
        Object.assign(
          (modelId: string, settings: CodexAppServerSettings) => {
            captured.codexModel = modelId;
            captured.codexSettings = settings;
            return new MockLanguageModelV4({
              doGenerate: async (params) => {
                captured.codexCall = params;
                return {
                  content: [],
                  finishReason: { unified: "stop", raw: undefined },
                  usage: {
                    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 0, text: 0, reasoning: 0 },
                  },
                  warnings: [],
                };
              },
            });
          },
          { close: async () => {} },
        ) as unknown as CodexAppServerProvider,
    }),
    pi: {
      ...createPiDriver(piDeps),
      ...(options.piRequestChecks === true ? {} : { requestChecks: () => [] }),
    },
  };
  const deps: ExecutionSeams = {
    generateText,
    evaluate: async () => {
      throw new Error("unexpected decision call");
    },
    resolveDriver: ((kind) => {
      if (kind === "claude") return testDrivers.claude;
      if (kind === "codex") return testDrivers.codex;
      if (kind === "pi") return testDrivers.pi;
      return driverFor(kind);
    }) as DriverResolver,
    factoryEnv: () => [],
    // The probe itself is covered in ./jit-marker.test.ts, against a server
    // that really cannot start.
    jitFailures: async () => undefined,
  };
  return { deps, captured, piDeps };
}

// executeAgent answers a union; every test but the resume-failure ones wants the
// successful arm.
async function agentStep(
  ...args: Parameters<typeof executeAgentWith>
): Promise<AgentResult<unknown>> {
  const result = await executeAgentWith(...args);
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

test("generic execution dependencies contain no driver-private operations", () => {
  expect(executionSeams).not.toHaveProperty("prepareCodexHome");
  expect(executionSeams).not.toHaveProperty("withCodexAppServer");
  expect(executionSeams).not.toHaveProperty("preparePiHome");
  expect(executionSeams).not.toHaveProperty("executePi");
});

test("claude agent step hydrates from wire config with the harness invariants forced", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude({
      model: "sonnet",
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
  expect(settings.spawnClaudeCodeProcess).toBeTypeOf("function");
  expect(captured.options?.system).toBeUndefined();
  expect(captured.homeRunIds).toEqual([]);
});

test("codex agent step runs on the app-server under an invocation home with fixed policies", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.codex({
      model: "gpt-5.5",
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
  expect(settings?.env?.CODEX_HOME).toMatch(
    new RegExp(`^${path.join(tmp, "codex-home", "run-7")}/`),
  );
  expect(settings?.mcpServers).toEqual({
    probe: { transport: "stdio", command: "node" },
  });
  expect(captured.homeRunIds).toEqual(["run-7"]);
});

test("a Codex descriptor that smuggles sandbox or config policy loses to jigs' policy", async () => {
  // A descriptor that skipped its constructor, as a hand-built wire could.
  const harness = {
    ...harnesses.codex({ model: "gpt-5.5", personality: "pragmatic" }),
    sandboxPolicy: "read-only",
    configOverrides: { sandbox_mode: "read-only", mcp_servers: {} },
  } as CodexHarness;
  const wire = buildAgentRequest({ harness, cwd: worktree, prompt: "implement it" });
  const { deps, captured } = makeDeps();

  await agentStep(wire, { workflowRunId: "run-smuggle" }, deps);

  const settings = captured.codexSettings;
  expect(settings?.personality).toBe("pragmatic");
  expect(settings?.sandboxPolicy).toBe("danger-full-access");
  expect(settings?.approvalPolicy).toBe("never");
  expect(settings).not.toHaveProperty("configOverrides");
});

test("parallel Codex invocations keep settings and homes private", async () => {
  const otherWorktree = path.join(tmp, "parallel-worktree");
  mkdirSync(otherWorktree, { recursive: true });
  const first = makeDeps();
  const second = makeDeps();

  await Promise.all([
    agentStep(
      buildAgentRequest({
        harness: harnesses.codex({
          model: "gpt-5.5",
          effort: "low",
          mcpServers: { alpha: { command: "alpha", probe: { tool: "ping" } } },
        }),
        cwd: worktree,
        prompt: "first",
      }),
      { workflowRunId: "same-run" },
      first.deps,
    ),
    agentStep(
      buildAgentRequest({
        harness: harnesses.codex({
          model: "gpt-6-astra",
          effort: "xhigh",
          mcpServers: { beta: { command: "beta", probe: { tool: "ping" } } },
        }),
        cwd: otherWorktree,
        prompt: "second",
      }),
      { workflowRunId: "same-run" },
      second.deps,
    ),
  ]);

  expect(first.captured.codexModel).toBe("gpt-5.5");
  expect(second.captured.codexModel).toBe("gpt-6-astra");
  expect(first.captured.codexSettings?.mcpServers).toEqual({
    alpha: { transport: "stdio", command: "alpha" },
  });
  expect(second.captured.codexSettings?.mcpServers).toEqual({
    beta: { transport: "stdio", command: "beta" },
  });
  const firstHome = first.captured.codexSettings?.env?.CODEX_HOME;
  const secondHome = second.captured.codexSettings?.env?.CODEX_HOME;
  expect(existsSync(firstHome ?? "")).toBe(false);
  expect(existsSync(secondHome ?? "")).toBe(false);
});

test("omitting effort leaves both providers' settings unset", async () => {
  const claudeRun = makeDeps();
  await agentStep(
    buildAgentRequest({
      harness: harnesses.claude({ model: "sonnet" }),
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
      harness: harnesses.codex({ model: "gpt-5.5" }),
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
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "judge it",
    output: verdict,
  });
  const { deps, captured, piDeps } = makeDeps({ output: { ok: true } });
  piDeps.executePi = async (options) => {
    captured.piOptions = options;
    const id = options.args[options.args.indexOf("--session-id") + 1];
    return {
      text: "done",
      output: { ok: true },
      providerMetadata: { pi: { sessionId: id } },
    };
  };

  const result = await agentStep(wire, { workflowRunId: "run-1" }, deps);

  expect(captured.options?.output).toBeDefined();
  expect(result.output).toEqual({ ok: true });
});

test("without an output schema no output spec is passed and output is undefined", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "just do it",
  });
  const { deps, captured } = makeDeps({ output: "should not surface" });

  const result = await agentStep(wire, { workflowRunId: "run-1" }, deps);

  expect(captured.options?.output).toBeUndefined();
  expect(result.output).toBeUndefined();
});

test("the Claude session reference is captured", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "go",
  });
  const { deps } = makeDeps({
    providerMetadata: { "claude-code": { sessionId: "s-42" } },
  });

  const result = await agentStep(wire, { workflowRunId: "run-1" }, deps);

  expect(result.session).toMatchObject({ harness: "claude", id: "s-42" });
});

test("the Codex threadId is captured, and a missing session reference is omitted, never an error", async () => {
  const codexWire = buildAgentRequest({
    harness: harnesses.codex({ model: "gpt-5.5" }),
    cwd: worktree,
    prompt: "go",
  });

  const withThread = makeDeps({
    providerMetadata: { "codex-app-server": { threadId: "t-7" } },
  });
  const threaded = await agentStep(codexWire, { workflowRunId: "run-1" }, withThread.deps);
  expect(threaded.session).toMatchObject({ harness: "codex", id: "t-7" });

  const bare = makeDeps();
  const sessionless = await agentStep(codexWire, { workflowRunId: "run-1" }, bare.deps);
  expect(sessionless.session).toBeUndefined();
  expect("session" in sessionless).toBe(false);
});

test("a claude resume rides on the settings' resume field", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "answer the review",
    resume: { harness: "claude", id: "s-42", descriptor: "" },
  });
  const { deps, captured } = makeDeps();

  await agentStep(wire, { workflowRunId: "run-1" }, deps);

  expect(claudeSettingsOf(captured).resume).toBe("s-42");
  expect(captured.options?.providerOptions).toBeUndefined();
});

test("a Claude transcript with messages but no summary resumes", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "answer the review",
    resume: { harness: "claude", id: "summaryless-session", descriptor: "" },
  });
  const { deps, captured } = makeDeps();
  const summaryless = createClaudeDriver({
    sessionMessages: async () => [{ type: "user", message: "interrupted first turn" }],
  });
  const resolveDriver = deps.resolveDriver;
  deps.resolveDriver = ((kind) =>
    kind === "claude" ? summaryless : resolveDriver(kind)) as DriverResolver;

  await agentStep(wire, { workflowRunId: "run-1" }, deps);

  expect(claudeSettingsOf(captured).resume).toBe("summaryless-session");
});

test("a missing Claude transcript reports resumeFailed before launch", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "answer the review",
    resume: { harness: "claude", id: "missing-session", descriptor: "" },
  });
  const { deps, captured } = makeDeps();
  const missing = createClaudeDriver({ sessionMessages: async () => [] });
  const resolveDriver = deps.resolveDriver;
  deps.resolveDriver = ((kind) =>
    kind === "claude" ? missing : resolveDriver(kind)) as DriverResolver;

  const result = await executeAgentWith(wire, { workflowRunId: "run-1" }, deps);

  expect(result).toEqual({
    resumeFailed: expect.stringContaining("Claude session missing-session is missing"),
  });
  expect(captured.options).toBeUndefined();
});

test("a codex resume rides on the call's providerOptions['codex-app-server'].threadId", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.codex({ model: "gpt-5.5" }),
    cwd: worktree,
    prompt: "answer the review",
    resume: { harness: "codex", id: "0199-thread", descriptor: "" },
  });
  const { deps, captured } = makeDeps();

  await agentStep(wire, { workflowRunId: "run-1" }, deps);
  const model = captured.options?.model as Pick<MockLanguageModelV4, "doGenerate">;
  await model.doGenerate({ prompt: [] });

  expect(captured.codexCall?.providerOptions).toEqual({
    "codex-app-server": { threadId: "0199-thread" },
  });
  // settings.resume is the provider's fallback, not the app-server contract.
  expect(captured.codexSettings?.resume).toBeUndefined();
});

test("a session reference recorded on the other harness reports resumeFailed, not a silently fresh session", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "answer the review",
    resume: { harness: "codex", id: "0199-thread", descriptor: "" },
  });
  const { deps, captured } = makeDeps();
  const jitFailures = vi.fn(async () => undefined);
  deps.jitFailures = jitFailures;

  const result = await executeAgentWith(wire, { workflowRunId: "run-1" }, deps);

  // The resume prompt was written for an agent that already holds the change,
  // so running it against a brand-new session would be a lie. The marker sends
  // the caller down the same rebuild path a stale session reference does.
  expect(result).toEqual({
    resumeFailed: expect.stringContaining("recorded on the codex harness"),
  });
  expect(captured.options).toBeUndefined();
  expect(jitFailures).not.toHaveBeenCalled();
});

test("Claude steps always run with bypass", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "judge it",
  });
  const { deps, captured } = makeDeps();

  await agentStep(wire, { workflowRunId: "run-1" }, deps);

  const settings = claudeSettingsOf(captured);
  expect(settings.permissionMode).toBe("bypassPermissions");
  expect(settings.allowDangerouslySkipPermissions).toBe(true);
});

test("a Codex execution failure during resume still throws", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.codex({ model: "gpt-5.5" }),
    cwd: worktree,
    prompt: "answer the review",
    resume: { harness: "codex", id: "0199-gone", descriptor: "" },
  });
  const { deps } = makeDeps();
  // The raw JSON-RPC error codex 0.149.1 actually raises — it matches no
  // wrapper the provider documents, which is why any error reads as stale.
  deps.generateText = () => {
    throw new Error("no rollout found for thread id 0199-gone");
  };

  await expect(executeAgentWith(wire, { workflowRunId: "run-1" }, deps)).rejects.toThrow(
    "no rollout found for thread id",
  );
});

test("a Claude execution failure during resume still throws", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "answer the review",
    resume: { harness: "claude", id: "s-42", descriptor: "" },
  });
  const { deps } = makeDeps();
  deps.generateText = () => {
    throw new Error("Claude stopped after launch");
  };

  await expect(executeAgentWith(wire, { workflowRunId: "run-1" }, deps)).rejects.toThrow(
    "Claude stopped after launch",
  );
});

test("a failure with no resume to blame still throws", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "go",
  });
  const { deps } = makeDeps();
  deps.generateText = () => {
    throw new Error("the harness fell over");
  };

  await expect(executeAgentWith(wire, { workflowRunId: "run-1" }, deps)).rejects.toThrow(
    "the harness fell over",
  );
});

test("a second agent in the same worktree is refused while the first is running", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "implement it",
  });
  let releaseFirst = () => {};
  const first = makeDeps();
  first.deps.generateText = async () => {
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    return { text: "done" };
  };

  const inFlight = agentStep(wire, { workflowRunId: "run-1" }, first.deps);
  // Yield so the first call is inside the lock before the second tries.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const second = makeDeps();
  await expect(executeAgentWith(wire, { workflowRunId: "run-1" }, second.deps)).rejects.toThrow(
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
    return { text: "done" };
  };

  const inFlight = agentStep(
    buildAgentRequest({
      harness: harnesses.claude({ model: "sonnet" }),
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
      harness: harnesses.claude({ model: "sonnet" }),
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

test("the step env is built, not copied: no API credentials, process.env untouched", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-scrub";
  try {
    const wire = buildAgentRequest({
      harness: harnesses.claude({ model: "sonnet" }),
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
    harness: harnesses.claude({ model: "sonnet" }),
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

  const result = await executeAgentWith(
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

test("request checks run by phase even when an installation check has the same id", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: worktree,
    prompt: "never reached",
  });
  const { deps, captured } = makeDeps();
  const resolveDriver = deps.resolveDriver;
  const claude = resolveDriver("claude");
  if (claude === undefined) throw new Error("Claude driver is missing");
  const requestProbe = vi.fn(async () => ({
    ok: false as const,
    reason: "request-specific failure",
    repair: "fix the request",
  }));
  const jitFailures = vi.fn(async () => undefined);
  deps.jitFailures = jitFailures;
  deps.resolveDriver = ((kind) =>
    kind === "claude"
      ? {
          ...claude,
          installationChecks: () => [
            {
              id: "shared-diagnostic",
              label: "Installation diagnostic",
              run: async () => ({ ok: true as const }),
            },
          ],
          requestChecks: () => [
            {
              id: "shared-diagnostic",
              label: "Request diagnostic",
              run: requestProbe,
            },
          ],
        }
      : resolveDriver(kind)) as DriverResolver;

  await expect(executeAgentWith(wire, { workflowRunId: "run-1" }, deps)).rejects.toThrow(
    /Request diagnostic: request-specific failure/,
  );
  expect(requestProbe).toHaveBeenCalledOnce();
  expect(jitFailures).not.toHaveBeenCalled();
  expect(captured.options).toBeUndefined();
});

test("claude ask step disables built-in tools, sees no MCP universe and loads no filesystem settings", async () => {
  const wire = buildAskAgentRequest({
    harness: harnesses.claude({ model: "sonnet" }),
    prompt: "summarize",
    system: "be terse",
  });
  const { deps, captured } = makeDeps();

  await agentStep(wire, { workflowRunId: "run-1" }, deps);

  const settings = claudeSettingsOf(captured);
  expect(settings.tools).toEqual([]);
  expect(settings.strictMcpConfig).toBe(true);
  expect(settings.mcpServers).toEqual({});
  expect(settings.settingSources).toEqual([]);
  expect(settings.cwd).toBeUndefined();
  expect(captured.options?.system).toBe("be terse");
});

test("askAgent rejects Codex, a Pi allowlist and a model source before any check or launch", async () => {
  const { deps, captured } = makeDeps({}, { piRequestChecks: true });
  const requestChecks = vi.spyOn(drivers.openrouter, "requestChecks");
  const ask = (harness: unknown) =>
    ({ harness, prompt: "never reached" }) as unknown as Parameters<typeof executeAgentWith>[0];
  const metadata = { workflowRunId: "run-1" };

  await expect(
    executeAgentWith(ask(harnesses.codex({ model: "gpt-5.5" })), metadata, deps),
  ).rejects.toThrow("askAgent() cannot use the Codex harness");
  await expect(
    executeAgentWith(
      ask(harnesses.pi(models.openrouter("m"), { tools: ["read"] })),
      metadata,
      deps,
    ),
  ).rejects.toThrow("askAgent() runs without tools");
  await expect(executeAgentWith(ask(models.openrouter("m")), metadata, deps)).rejects.toThrow(
    "openrouter is a model source, not an agent harness",
  );
  expect(requestChecks).not.toHaveBeenCalled();
  expect(captured.homeRunIds).toEqual([]);
  expect(captured.piHome).toBeUndefined();
  expect(captured.options).toBeUndefined();
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
  const harness = harnesses.pi(source, { thinking: "medium" });
  const wire = buildAskAgentRequest({
    harness,
    prompt: "judge it",
    output: verdict,
  });
  const { deps, captured } = makeDeps({
    output: { ok: true },
    providerMetadata: { pi: { sessionId: "pi-session" } },
  });

  const result = await agentStep(wire, { workflowRunId: "run-pi" }, deps);

  expect(captured.piHome).toEqual({ runId: "run-pi", model: planPiModel(harness) });
  expect(captured.piOptions?.args).toEqual([
    "--mode",
    "json",
    "--tools",
    "submit_result",
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
  expect(captured.piOptions?.requireResult).toBe(true);
  expect(captured.piOptions?.env.PI_CODING_AGENT_DIR).toMatch(
    new RegExp(`^${path.join(tmp, "pi-home", "run-pi")}/`),
  );
  expect(existsSync(captured.piOptions?.env.PI_CODING_AGENT_DIR ?? "")).toBe(false);
  expect(existsSync(captured.piOptions?.cwd ?? "")).toBe(false);
  expect(result).toEqual({
    text: "done",
    output: { ok: true },
  });
});

test("pi plain ask disables every tool and loads no result tool", async () => {
  const wire = buildAskAgentRequest({
    harness: harnesses.pi(models.openaiCodex("gpt-5.5")),
    prompt: "say hello",
  });
  const { deps, captured } = makeDeps({ text: "hello" });

  const result = await agentStep(wire, { workflowRunId: "run-pi-plain" }, deps);

  const args = captured.piOptions?.args ?? [];
  expect(args).toContain("--no-tools");
  expect(args).not.toContain("--tools");
  expect(args).not.toContain("-e");
  expect(args.at(-1)).toBe("say hello");
  expect(captured.piOptions?.requireResult).toBe(false);
  expect(result).toEqual({ text: "hello" });
});

test("pi ask rejects an unreachable nested endpoint before executing Pi", async () => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("connection refused");
  });
  const { deps, captured } = makeDeps({}, { piRequestChecks: true });
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

  await expect(executeAgentWith(wire, { workflowRunId: "run-pi" }, deps)).rejects.toThrow(
    /offline-studio model endpoint: offline-studio is unreachable/,
  );
  expect(captured.piOptions).toBeUndefined();
});

test("pi ask rejects missing nested authentication before executing Pi", async () => {
  vi.stubEnv("PI_TEST_OPENROUTER_KEY", "");
  const { deps, captured } = makeDeps({}, { piRequestChecks: true });
  const wire = buildAskAgentRequest({
    harness: harnesses.pi(
      models.openrouter("openai/gpt-oss", { apiKeyEnv: "PI_TEST_OPENROUTER_KEY" }),
    ),
    prompt: "hello",
  });

  await expect(executeAgentWith(wire, { workflowRunId: "run-pi" }, deps)).rejects.toThrow(
    /PI_TEST_OPENROUTER_KEY credential: PI_TEST_OPENROUTER_KEY is not set/,
  );
  expect(captured.piOptions).toBeUndefined();
});

test("pi maps only the selected OpenRouter credential to the provider variable", async () => {
  vi.stubEnv("TEAM_OPENROUTER_KEY", "selected-secret");
  vi.stubEnv("OPENROUTER_API_KEY", "unrelated-secret");
  const wire = buildAskAgentRequest({
    harness: harnesses.pi(
      models.openrouter("openai/gpt-oss", { apiKeyEnv: "TEAM_OPENROUTER_KEY" }),
    ),
    prompt: "hello",
  });
  const { deps, captured } = makeDeps({}, { piRequestChecks: true });

  await agentStep(wire, { workflowRunId: "run-pi-custom-key" }, deps);

  expect(captured.piOptions?.env.OPENROUTER_API_KEY).toBe("selected-secret");
  expect(captured.piOptions?.env).not.toHaveProperty("TEAM_OPENROUTER_KEY");
  expect(JSON.stringify(wire)).not.toContain("selected-secret");
  expect(JSON.stringify(captured.piHome)).not.toContain("selected-secret");
});

test("pi run mints and records a matching session with tools in the worktree", async () => {
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
  const { deps, captured, piDeps } = makeDeps({ output: { ok: true } });
  piDeps.executePi = async (options) => {
    captured.piOptions = options;
    const id = options.args[options.args.indexOf("--session-id") + 1];
    return {
      text: "done",
      output: { ok: true },
      providerMetadata: { pi: { sessionId: id } },
    };
  };

  const result = await agentStep(wire, { workflowRunId: "run-pi-worktree" }, deps);

  const args = captured.piOptions?.args ?? [];
  const sessionId = args[args.indexOf("--session-id") + 1];
  expect(sessionId).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
  expect(args).toContain("--tools");
  expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,submit_result");
  expect(args).not.toContain("--no-tools");
  expect(args[args.indexOf("--session-dir") + 1]).toBe(
    path.join(tmp, "pi-home", "run-pi-worktree", "sessions"),
  );
  expect(captured.piOptions?.cwd).toBe(worktree);
  expect(result.session).toMatchObject({ harness: "pi", id: sessionId });
  expect(result.output).toEqual({ ok: true });
  expect(captured.piOptions?.requireResult).toBe(true);
  const extension = args[args.indexOf("-e") + 1];
  if (extension === undefined) throw new Error("Pi output extension was not passed");
  expect(extension).toContain("submit-result.ts");
  expect(existsSync(extension)).toBe(false);
});

test("pi run translates its declared MCP universe into a private adapter extension", async () => {
  vi.stubEnv("PI_TEST_MCP_TOKEN", "step-secret");
  vi.stubEnv("PI_TEST_STDIO_TOKEN", "stdio-secret");
  const harness = harnesses.pi(
    models.openrouter("openai/gpt-oss", { apiKeyEnv: "PI_TEST_STDIO_TOKEN" }),
    {
      mcpServers: {
        local: {
          command: "node",
          args: ["server.mjs"],
          env: { TOKEN: "PI_TEST_STDIO_TOKEN" },
          tools: ["ping"],
          probe: { tool: "ping" },
        },
        remote: {
          url: "https://mcp.example.test",
          bearerTokenEnv: "PI_TEST_MCP_TOKEN",
          tools: ["lookup"],
          probe: { tool: "lookup" },
        },
      },
    },
  );
  const wire = buildAgentRequest({ harness, cwd: worktree, prompt: "use MCP" });
  const { deps, captured, piDeps } = makeDeps();
  let source = "";
  piDeps.executePi = async (options) => {
    captured.piOptions = options;
    const extension = options.args[options.args.indexOf("-e") + 1];
    if (extension === undefined) throw new Error("Pi MCP extension was not passed");
    source = readFileSync(extension, "utf8");
    const id = options.args[options.args.indexOf("--session-id") + 1];
    return { text: "done", providerMetadata: { pi: { sessionId: id } } };
  };

  await agentStep(wire, { workflowRunId: "run-pi-mcp" }, deps);

  expect(source).toContain('"local":{"command":"node","args":["server.mjs"]');
  expect(source).toContain('"env":{"TOKEN":"$env:PI_TEST_STDIO_TOKEN"}');
  expect(source).toContain('"directTools":["ping"]');
  expect(source).toContain('"remote":{"url":"https://mcp.example.test"');
  expect(source).toContain('"bearerTokenEnv":"PI_TEST_MCP_TOKEN"');
  expect(source).not.toContain("step-secret");
  expect(source).not.toContain("stdio-secret");
  expect(captured.piOptions?.env.PI_TEST_MCP_TOKEN).toBe("step-secret");
  expect(captured.piOptions?.env.PI_TEST_STDIO_TOKEN).toBe("stdio-secret");
  expect(captured.piOptions?.env.OPENROUTER_API_KEY).toBe("stdio-secret");
});

test("pi preserves explicit built-in tools while adding MCP and result tools", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.pi(models.openrouter("openai/gpt-oss"), {
      tools: ["read"],
      mcpServers: {
        allowed: { command: "node", tools: ["ping"], probe: { tool: "ping" } },
      },
    }),
    cwd: worktree,
    prompt: "use MCP",
    output: verdict,
  });
  const { deps, captured, piDeps } = makeDeps({ output: { ok: true } });
  piDeps.executePi = async (options) => {
    captured.piOptions = options;
    const id = options.args[options.args.indexOf("--session-id") + 1];
    return {
      text: "done",
      output: { ok: true },
      providerMetadata: { pi: { sessionId: id } },
    };
  };

  await agentStep(wire, { workflowRunId: "run-pi-tool-filter" }, deps);

  const args = captured.piOptions?.args ?? [];
  expect(args[args.indexOf("--tools") + 1]).toBe("read,allowed_ping,submit_result");
});

test("pi rejects unsupported MCP and ask configurations before probes or model checks", async () => {
  const invalidRun = buildAgentRequest({
    harness: {
      ...harnesses.pi(models.openrouter("openai/gpt-oss")),
      mcpServers: {
        invalid: { command: "node", tools: ["other"], probe: { tool: "ping" } },
      },
    },
    cwd: worktree,
    prompt: "never reached",
  });
  const run = makeDeps({}, { piRequestChecks: true });
  run.deps.jitFailures = vi.fn(async () => undefined);

  await expect(
    executeAgentWith(invalidRun, { workflowRunId: "invalid-run" }, run.deps),
  ).rejects.toThrow("must allow its probe tool 'ping'");
  expect(run.deps.jitFailures).not.toHaveBeenCalled();
  expect(run.captured.piHome).toBeUndefined();

  const invalidAsk = {
    harness: {
      ...harnesses.pi(models.openrouter("openai/gpt-oss")),
      mcpServers: {
        probe: { command: "node", tools: ["ping"], probe: { tool: "ping" } },
      },
    },
    prompt: "never reached",
  } as unknown as Parameters<typeof executeAgentWith>[0];
  const ask = makeDeps({}, { piRequestChecks: true });
  await expect(
    executeAgentWith(invalidAsk, { workflowRunId: "invalid-ask" }, ask.deps),
  ).rejects.toThrow("askAgent() has no MCP universe");
  expect(ask.captured.piHome).toBeUndefined();
});

test("pi rejects missing step-side MCP credentials before probing a server", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "model-secret");
  vi.stubEnv("PI_MISSING_MCP_TOKEN", "");
  const wire = buildAgentRequest({
    harness: harnesses.pi(models.openrouter("openai/gpt-oss"), {
      mcpServers: {
        probe: {
          command: "never-contacted",
          env: { TOKEN: "PI_MISSING_MCP_TOKEN" },
          tools: ["ping"],
          probe: { tool: "ping" },
        },
      },
    }),
    cwd: worktree,
    prompt: "never reached",
  });
  const run = makeDeps({}, { piRequestChecks: true });
  run.deps.jitFailures = vi.fn(async () => undefined);

  await expect(
    executeAgentWith(wire, { workflowRunId: "missing-mcp-secret" }, run.deps),
  ).rejects.toThrow("PI_MISSING_MCP_TOKEN");
  expect(run.deps.jitFailures).not.toHaveBeenCalled();
  expect(run.captured.piHome).toBeUndefined();
});

test("parallel pi runs keep different MCP universes in separate extensions", async () => {
  const otherWorktree = path.join(tmp, "pi-parallel-worktree");
  mkdirSync(otherWorktree);
  const first = makeDeps();
  const second = makeDeps();
  let firstSource = "";
  let secondSource = "";
  first.piDeps.executePi = async (options) => {
    const extension = options.args[options.args.indexOf("-e") + 1];
    if (extension === undefined) throw new Error("first Pi MCP extension was not passed");
    firstSource = readFileSync(extension, "utf8");
    const id = options.args[options.args.indexOf("--session-id") + 1];
    return { text: "first", providerMetadata: { pi: { sessionId: id } } };
  };
  second.piDeps.executePi = async (options) => {
    const extension = options.args[options.args.indexOf("-e") + 1];
    if (extension === undefined) throw new Error("second Pi MCP extension was not passed");
    secondSource = readFileSync(extension, "utf8");
    const id = options.args[options.args.indexOf("--session-id") + 1];
    return { text: "second", providerMetadata: { pi: { sessionId: id } } };
  };

  await Promise.all([
    agentStep(
      buildAgentRequest({
        harness: harnesses.pi(models.openrouter("openai/gpt-oss"), {
          mcpServers: {
            alpha: { command: "alpha", tools: ["one"], probe: { tool: "one" } },
          },
        }),
        cwd: worktree,
        prompt: "first",
      }),
      { workflowRunId: "same-pi-run" },
      first.deps,
    ),
    agentStep(
      buildAgentRequest({
        harness: harnesses.pi(models.openrouter("openai/gpt-oss"), {
          mcpServers: {
            beta: { command: "beta", tools: ["two"], probe: { tool: "two" } },
          },
        }),
        cwd: otherWorktree,
        prompt: "second",
      }),
      { workflowRunId: "same-pi-run" },
      second.deps,
    ),
  ]);

  expect(firstSource).toContain('"alpha"');
  expect(firstSource).not.toContain('"beta"');
  expect(secondSource).toContain('"beta"');
  expect(secondSource).not.toContain('"alpha"');
});

test("pi run returns a stale resume marker before spawning Pi", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.pi(models.openrouter("openai/gpt-oss")),
    cwd: worktree,
    prompt: "continue",
    resume: { harness: "pi", id: "missing-session", descriptor: "" },
  });
  const { deps, captured } = makeDeps();

  const result = await executeAgentWith(wire, { workflowRunId: "run-pi-stale" }, deps);

  expect(result).toEqual({
    resumeFailed: expect.stringMatching(/missing-session.*run-pi-stale\/sessions/),
  });
  expect(captured.piOptions).toBeUndefined();
});

test("pi run resumes only after finding the real session file", async () => {
  const sessionId = "existing-session";
  const harness = harnesses.pi(models.openrouter("openai/gpt-oss"));
  const wire = buildAgentRequest({
    harness,
    cwd: worktree,
    prompt: "continue",
    resume: { harness: "pi", id: sessionId, descriptor: "" },
  });
  const { deps, captured, piDeps } = makeDeps();
  const prepared = await piDeps.preparePiHome("run-pi-resume", planPiModel(harness));
  writeFileSync(path.join(prepared.sessionDir, `2026-09-21T00-00-00_${sessionId}.jsonl`), "");
  piDeps.executePi = async (options) => {
    captured.piOptions = options;
    return { text: "continued", providerMetadata: { pi: { sessionId } } };
  };

  const result = await agentStep(wire, { workflowRunId: "run-pi-resume" }, deps);

  const args = captured.piOptions?.args ?? [];
  expect(args).not.toContain("--session-id");
  expect(args[args.indexOf("--session") + 1]).toBe(
    path.join(prepared.sessionDir, `2026-09-21T00-00-00_${sessionId}.jsonl`),
  );
  expect(result.session).toMatchObject({ harness: "pi", id: sessionId });
});

test("pi run rejects a different session id reported by Pi", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.pi(models.openrouter("openai/gpt-oss")),
    cwd: worktree,
    prompt: "implement it",
  });
  const { deps, piDeps } = makeDeps();
  piDeps.executePi = async () => ({
    text: "done",
    providerMetadata: { pi: { sessionId: "different-session" } },
  });

  await expect(executeAgentWith(wire, { workflowRunId: "run-pi-mismatch" }, deps)).rejects.toThrow(
    /Pi reported session.*different-session.*jigs-/,
  );
});

test("a Pi execution failure during resume still throws", async () => {
  const sessionId = "existing-session";
  const source = models.openrouter("openai/gpt-oss");
  const wire = buildAgentRequest({
    harness: harnesses.pi(source),
    cwd: worktree,
    prompt: "continue",
    resume: { harness: "pi", id: sessionId, descriptor: "" },
  });
  const { deps, piDeps } = makeDeps();
  const prepared = await piDeps.preparePiHome(
    "run-pi-execution-failure",
    planPiModel(harnesses.pi(source)),
  );
  writeFileSync(path.join(prepared.sessionDir, `2026_${sessionId}.jsonl`), "");
  piDeps.executePi = async () => {
    throw new Error("Pi stopped after launch");
  };

  await expect(
    executeAgentWith(wire, { workflowRunId: "run-pi-execution-failure" }, deps),
  ).rejects.toThrow("Pi stopped after launch");
});

test("a resumed Pi session-id mismatch still throws after launch", async () => {
  const sessionId = "existing-session";
  const source = models.openrouter("openai/gpt-oss");
  const wire = buildAgentRequest({
    harness: harnesses.pi(source),
    cwd: worktree,
    prompt: "continue",
    resume: { harness: "pi", id: sessionId, descriptor: "" },
  });
  const { deps, piDeps } = makeDeps();
  const prepared = await piDeps.preparePiHome(
    "run-pi-resume-mismatch",
    planPiModel(harnesses.pi(source)),
  );
  writeFileSync(path.join(prepared.sessionDir, `2026_${sessionId}.jsonl`), "");
  piDeps.executePi = async () => ({
    text: "work already completed",
    providerMetadata: { pi: { sessionId: "different-session" } },
  });

  await expect(
    executeAgentWith(wire, { workflowRunId: "run-pi-resume-mismatch" }, deps),
  ).rejects.toThrow(/Pi reported session.*different-session.*existing-session/);
});

test("pi run leaves Pi's default tools enabled when no allowlist is supplied", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.pi(models.openrouter("openai/gpt-oss")),
    cwd: worktree,
    prompt: "implement it",
  });
  const { deps, captured, piDeps } = makeDeps();
  piDeps.executePi = async (options) => {
    captured.piOptions = options;
    const id = options.args[options.args.indexOf("--session-id") + 1];
    return { text: "done", providerMetadata: { pi: { sessionId: id } } };
  };

  await agentStep(wire, { workflowRunId: "run-pi-default-tools" }, deps);

  expect(captured.piOptions?.args).not.toContain("--tools");
  expect(captured.piOptions?.args).not.toContain("--no-tools");
});

test("pi run rejects an unreachable nested endpoint before spawning Pi", async () => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("connection refused");
  });
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
  const { deps, captured } = makeDeps({}, { piRequestChecks: true });

  await expect(executeAgentWith(wire, { workflowRunId: "run-pi-offline" }, deps)).rejects.toThrow(
    /offline-studio model endpoint: offline-studio is unreachable/,
  );
  expect(captured.piOptions).toBeUndefined();
});

test("a pi session that cannot resume takes the agent session's fresh arm", async () => {
  const harness = harnesses.pi(models.openrouter("openai/gpt-oss"));
  const { deps, piDeps } = makeDeps({ output: { ok: true } });
  const spawnedIds: Array<string | undefined> = [];
  // The fake never writes a session file, so the first turn's session is
  // missing by the time the second turn tries to resume it.
  piDeps.executePi = async (options) => {
    const id = options.args[options.args.indexOf("--session-id") + 1];
    spawnedIds.push(id);
    return {
      text: "done",
      output: { ok: true },
      providerMetadata: { pi: { sessionId: id } },
    };
  };
  const runAgent: RunAgentFn = async <T>(config: RunAgentOptions<T>) => {
    const stepResult = await executeAgentWith(
      buildAgentRequest(config),
      { workflowRunId: "run-pi-rebuild" },
      deps,
    );
    const result = unwrapAgentStep(stepResult);
    return { ...result, output: parseOutput(config.output, result.output) } as AgentResult<T>;
  };
  const session = bindAgentSession(runAgent)({ name: "pi-test", harness, cwd: worktree });

  await session.run({ resume: "continue", fresh: "start", output: verdict });
  const output = await session.run({ resume: "continue", fresh: "start again", output: verdict });

  expect(output).toEqual({ ok: true });
  expect(spawnedIds).toHaveLength(2);
  expect(spawnedIds[1]).not.toBe(spawnedIds[0]);
});

test("pi run honors JIT failure before creating its invocation home or spawning", async () => {
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

  const result = await executeAgentWith(wire, { workflowRunId: "run-pi-jit" }, deps);

  expect(result).toEqual({
    jitFailure: [expect.objectContaining({ id: "github.marker", reason: "not ready" })],
  });
  expect(captured.piHome).toBeUndefined();
  expect(captured.piOptions).toBeUndefined();
});

test("the JIT checks and the harness get the same environment, built from the base set, driver and factory names", async () => {
  vi.stubEnv("DRIVER_VAR", "driver");
  vi.stubEnv("FACTORY_VAR", "factory");
  vi.stubEnv("SYNTHETIC_DATABASE_URL", "postgres://user:secret@db/app");
  vi.stubEnv("SYNTHETIC_PRIVATE_KEY", "synthetic-key");
  let jitEnv: Record<string, string> | undefined;
  let runEnv: Record<string, string> | undefined;
  const driver = {
    ...createClaudeDriver(),
    requestChecks: () => [],
    envAllowlist: () => ["DRIVER_VAR"],
    open: async (_target: unknown, context: { env: Record<string, string> }) => {
      runEnv = context.env;
      return { model: new MockLanguageModelV4(), close: async () => {} };
    },
  };
  const deps: ExecutionSeams = {
    ...executionSeams,
    generateText: async () => ({ text: "done" }),
    resolveDriver: (() => driver) as unknown as DriverResolver,
    factoryEnv: () => ["FACTORY_VAR"],
    jitFailures: async (_wire, env) => {
      jitEnv = env;
      return undefined;
    },
  };
  try {
    await agentStep(
      buildAgentRequest({
        harness: harnesses.claude({ model: "sonnet" }),
        cwd: worktree,
        prompt: "p",
      }),
      { workflowRunId: "run-env" },
      deps,
    );
  } finally {
    vi.unstubAllEnvs();
  }
  expect(jitEnv).toBe(runEnv);
  const names = Object.keys(runEnv ?? {});
  expect(names).toEqual(expect.arrayContaining(["PATH", "DRIVER_VAR", "FACTORY_VAR"]));
  expect(names).not.toContain("SYNTHETIC_DATABASE_URL");
  expect(names).not.toContain("SYNTHETIC_PRIVATE_KEY");
});
