import { mkdirSync } from "node:fs";
import path from "node:path";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { FatalError } from "workflow";
import { JigsError } from "../../errors.ts";
import { JitCheckError } from "../../workflow/agents/agent.ts";
import { harnesses, models } from "../../workflow/agents/harness-config.ts";
import type { Driver, DriverResolver } from "./drivers/index.ts";
import type { OpenContext } from "./drivers/types.ts";
import {
  cancellableRun,
  makeTmpDir,
  removeTmpDir,
  runningRunStatus,
} from "./harnesses/test-fixtures.ts";
import { RunCancelledError } from "./run-cancellation.ts";
import { createAgentRunner, forFactoryStep, openAgentRunner } from "./runner.ts";
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

function fakeClaude(model = new MockLanguageModelV4()) {
  const closed = vi.fn(async () => {});
  const opened: OpenContext[] = [];
  const driver: Driver<"claude"> = {
    kind: "claude",
    family: "harness",
    open: async (_target, context) => {
      opened.push(context);
      return { model, close: closed };
    },
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
    runStatus: runningRunStatus,
  };
  return { seams, closed, opened };
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

test("a cancelled run is refused before the harness opens, and the worktree is released", async () => {
  const { seams, opened } = fakeClaude();
  seams.runStatus = cancellableRun("cancelled");

  const opening = openAgentRunner(claude, { cwd: worktree, run }, seams);

  await expect(opening).rejects.toBeInstanceOf(RunCancelledError);
  await expect(opening).rejects.toSatisfy((error) => FatalError.is(error));
  expect(opened).toHaveLength(0);
  seams.runStatus = runningRunStatus;
  await (await openAgentRunner(claude, { cwd: worktree, run }, seams)).close();
});

test("a factory step's model aborts its provider call once the run is cancelled", async () => {
  const status = cancellableRun();
  const model = new MockLanguageModelV4({
    doGenerate: async ({ abortSignal }) => {
      status.cancel();
      await new Promise((resolve) => abortSignal?.addEventListener("abort", resolve));
      throw abortSignal?.reason;
    },
  });
  const { seams, opened } = fakeClaude(model);
  seams.runStatus = status;
  const runner = forFactoryStep(await openAgentRunner(claude, { cwd: worktree, run }, seams));

  try {
    await expect(generateText({ model: runner.model, prompt: "go" })).rejects.toSatisfy((error) =>
      FatalError.is(error),
    );
    expect(opened[0]?.signal.aborted).toBe(true);
  } finally {
    await runner.close();
  }
});

// A provider whose own error wins the race with the SDK's abort handling, as
// Codex's "app-server exited" can once its process group is stopped.
function losingProvider(status: ReturnType<typeof cancellableRun>, how: "part" | "reject") {
  const stopped = () => new Error("Client closed while request in flight");
  return new MockLanguageModelV4({
    doGenerate: async () => {
      status.cancel();
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw stopped();
    },
    doStream: async () => {
      status.cancel();
      return {
        stream: new ReadableStream({
          async start(controller) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (how === "reject") return controller.error(stopped());
            controller.enqueue({ type: "error", error: stopped() });
            controller.close();
          },
        }),
      };
    },
  });
}

async function factoryRunner(
  model: MockLanguageModelV4,
  status: ReturnType<typeof cancellableRun>,
) {
  const { seams } = fakeClaude(model);
  seams.runStatus = status;
  return forFactoryStep(await openAgentRunner(claude, { cwd: worktree, run }, seams));
}

test("a factory step's generate call fails with the cancellation whatever the provider throws", async () => {
  const status = cancellableRun();
  const runner = await factoryRunner(losingProvider(status, "part"), status);
  try {
    await expect(generateText({ model: runner.model, prompt: "go" })).rejects.toSatisfy(
      (error) => error instanceof RunCancelledError && FatalError.is(error),
    );
  } finally {
    await runner.close();
  }
});

for (const how of ["part", "reject"] as const) {
  test(`a factory step's streamed text rejects with the cancellation when the provider errors by ${how}`, async () => {
    const status = cancellableRun();
    const runner = await factoryRunner(losingProvider(status, how), status);
    try {
      const result = streamText({ model: runner.model, prompt: "go", onError: () => {} });
      await expect(result.text).rejects.toSatisfy(
        (error) => error instanceof RunCancelledError && FatalError.is(error),
      );
    } finally {
      await runner.close();
    }
  });
}

test("a factory step's provider error with no cancellation stays ordinary and retryable", async () => {
  const status = cancellableRun();
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error("rate limited");
    },
  });
  const runner = await factoryRunner(model, status);
  try {
    await expect(
      generateText({ model: runner.model, prompt: "go", maxRetries: 0 }),
    ).rejects.toSatisfy(
      (error) =>
        !(error instanceof RunCancelledError) &&
        !FatalError.is(error) &&
        (error as Error).message.includes("rate limited"),
    );
  } finally {
    await runner.close();
  }
});

test("closing the runner ends its watch on the run", async () => {
  const status = cancellableRun();
  const { seams, opened } = fakeClaude();
  seams.runStatus = status;
  const runner = await openAgentRunner(claude, { cwd: worktree, run }, seams);
  await runner.close();

  status.cancel();
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(opened[0]?.signal.aborted).toBe(false);
});
