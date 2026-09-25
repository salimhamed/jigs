import { mkdirSync } from "node:fs";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { JigsError } from "../../errors.ts";
import { JitCheckError } from "../../workflow/agents/agent.ts";
import { harnesses, models } from "../../workflow/agents/harness-config.ts";
import type { Driver, DriverResolver } from "./drivers/index.ts";
import { makeTmpDir, removeTmpDir } from "./harnesses/test-fixtures.ts";
import { createAgentRunner, openAgentRunner } from "./runner.ts";
import { type ExecutionSeams, executionSeams } from "./seams.ts";
import { AgentSessionError } from "./session-error.ts";

let tmp: string;
let worktree: string;
const savedDataHome = process.env.XDG_DATA_HOME;
beforeAll(() => {
  tmp = makeTmpDir();
  worktree = path.join(tmp, "worktree");
  mkdirSync(worktree);
  process.env.XDG_DATA_HOME = path.join(tmp, "data");
});
afterAll(() => {
  removeTmpDir(tmp);
  if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedDataHome;
});

function fakeClaude() {
  const closed = vi.fn(async () => {});
  const driver: Driver<"claude"> = {
    kind: "claude",
    family: "harness",
    open: async () => ({ model: new MockLanguageModelV4(), close: closed }),
    installationChecks: () => [],
    requestChecks: () => [],
    envAllowlist: () => [],
    sessionPointer: { providerKey: "claude-code", field: "sessionId" },
    setsEnv: [],
    displayName: "Claude Code",
  };
  const seams: ExecutionSeams = {
    ...executionSeams,
    resolveDriver: (() => driver) as unknown as DriverResolver,
    factoryEnv: () => [],
    jitFailures: async () => undefined,
  };
  return { seams, closed };
}

const claude = harnesses.claude({ model: "sonnet" });
const run = { workflowRunId: "run-1" };

test("a Pi descriptor is refused, pointing at runAgent", async () => {
  const pi = harnesses.pi(models.openaiCodex("gpt-5.5"));
  const opening = createAgentRunner(pi, { cwd: worktree, run });
  await expect(opening).rejects.toBeInstanceOf(JigsError);
  await expect(opening).rejects.toThrow("runAgent");
});

test("the runner holds the worktree until it is closed, and closes once", async () => {
  const { seams, closed } = fakeClaude();
  const runner = await openAgentRunner(claude, { cwd: worktree, run }, seams);
  await expect(openAgentRunner(claude, { cwd: worktree, run }, seams)).rejects.toThrow(
    "an agent is already running",
  );
  await Promise.all([runner.close(), runner.close()]);
  expect(closed).toHaveBeenCalledTimes(1);
  const next = await openAgentRunner(claude, { cwd: worktree, run }, seams);
  await next.close();
});

test("the session comes from the provider metadata, recorded on this descriptor", async () => {
  const { seams } = fakeClaude();
  const runner = await openAgentRunner(claude, { cwd: worktree, run }, seams);
  try {
    expect(
      runner.sessionFrom({ providerMetadata: { "claude-code": { sessionId: "s-1" } } }),
    ).toEqual({ harness: "claude", id: "s-1", descriptor: '{"kind":"claude","model":"sonnet"}' });
    expect(runner.sessionFrom({})).toBeUndefined();
  } finally {
    await runner.close();
  }
});

test("a failed JIT check throws before the lock is taken", async () => {
  const { seams } = fakeClaude();
  const failure = {
    ok: false as const,
    id: "mcp.s",
    label: "MCP server s",
    reason: "down",
    repair: "start it",
  };
  seams.jitFailures = async () => [failure];
  await expect(openAgentRunner(claude, { cwd: worktree, run }, seams)).rejects.toBeInstanceOf(
    JitCheckError,
  );
  const { seams: healthy } = fakeClaude();
  await (await openAgentRunner(claude, { cwd: worktree, run }, healthy)).close();
});

test("a session recorded on another harness is an AgentSessionError", async () => {
  const { seams } = fakeClaude();
  await expect(
    openAgentRunner(
      claude,
      { cwd: worktree, run, resume: { harness: "codex", id: "t", descriptor: "" } },
      seams,
    ),
  ).rejects.toBeInstanceOf(AgentSessionError);
});
