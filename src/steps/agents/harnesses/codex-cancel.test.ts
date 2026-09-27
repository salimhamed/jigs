import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { streamText } from "ai";
import { createCodexAppServer } from "ai-sdk-provider-codex-cli";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FatalError } from "workflow";
import { harnesses } from "../../../workflow/agents/harness-config.ts";
import { buildAgentRequest } from "../../../workflow/agents/plan.ts";
import { createCodexDriver } from "../drivers/codex.ts";
import { type DriverResolver, driverFor } from "../drivers/index.ts";
import { executeAgentWith } from "../execute-agent.ts";
import { RunCancelledError } from "../run-cancellation.ts";
import { forFactoryStep, openAgentRunner } from "../runner.ts";
import { executionSeams } from "../seams.ts";
import { codexSessionFile, prepareCodexInvocationHome } from "./codex-home.ts";
import { cancellableRun, makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

// Speaks just enough app-server JSON-RPC for one turn. Once the turn starts it
// records its pids in its working directory, beside a TERM-ignoring child that
// stands in for an MCP server. With `answer`, it finishes the turn.
function installFakeCodex(answer: string | undefined): void {
  const bin = path.join(tmp, "bin");
  mkdirSync(bin);
  const codex = path.join(bin, "codex");
  writeFileSync(
    codex,
    `#!${process.execPath}
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
const answer = ${JSON.stringify(answer ?? null)};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const notify = (method, params) => send({ method, params: { threadId: "thread-1", ...params } });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (method === "initialize")
    send({ id, result: { userAgent: "codex_cli_rs/0.200.0", capabilities: {} } });
  if (method === "thread/start") send({ id, result: { thread: { id: "thread-1" } } });
  if (method !== "turn/start") return;
  const mcp = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1e6)"], { stdio: ["ignore", "pipe", "ignore"] });
  send({ id, result: { turn: { id: "turn-1", items: [], status: "inProgress" } } });
  mcp.stdout.once("data", () => {
    writeFileSync("pids.json", JSON.stringify({ launcher: process.ppid, server: process.pid, mcp: mcp.pid }));
    if (answer === null) return;
    notify("item/agentMessage/delta", { turnId: "turn-1", itemId: "msg-1", delta: answer });
    notify("turn/completed", { turn: { id: "turn-1", items: [], status: "completed" } });
  });
});
`,
  );
  chmodSync(codex, 0o755);
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
}

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function codexSetup(run: ReturnType<typeof cancellableRun>) {
  const worktree = path.join(tmp, "worktree");
  mkdirSync(worktree);
  const auth = path.join(tmp, "auth.json");
  writeFileSync(auth, "{}");
  const codex = createCodexDriver({
    prepareCodexHome: async (runId) =>
      prepareCodexInvocationHome(runId, {
        baseDir: path.join(tmp, "codex-homes"),
        realAuthPath: auth,
      }),
    sessionFile: codexSessionFile,
    createAppServer: () => createCodexAppServer(),
  });
  const seams = {
    ...executionSeams,
    runStatus: run,
    factoryEnv: () => [],
    jitFailures: async () => undefined,
    resolveDriver: ((kind) => (kind === "codex" ? codex : driverFor(kind))) as DriverResolver,
  };
  const pids = path.join(worktree, "pids.json");
  const started = async () => {
    await expect.poll(() => existsSync(pids), { timeout: 10_000, interval: 25 }).toBe(true);
    return JSON.parse(readFileSync(pids, "utf8")) as {
      launcher: number;
      server: number;
      mcp: number;
    };
  };
  return { worktree, seams, started };
}

function startStep(run: ReturnType<typeof cancellableRun>) {
  const { worktree, seams, started } = codexSetup(run);
  const step = executeAgentWith(
    buildAgentRequest({
      harness: harnesses.codex({ model: "gpt-5.5" }),
      cwd: worktree,
      prompt: "Wait.",
    }),
    { workflowRunId: "codex-cancel" },
    seams,
  );
  return { step, started };
}

test("cancelling the run stops the Codex launcher, app server and MCP child", async () => {
  installFakeCodex(undefined);
  const run = cancellableRun();
  const { step, started } = startStep(run);
  const settled = expect(step).rejects.toSatisfy(
    (error) => error instanceof RunCancelledError && FatalError.is(error),
  );
  try {
    const pids = await started();
    for (const pid of Object.values(pids)) expect(pidIsRunning(pid)).toBe(true);
    const cancelledAt = Date.now();

    run.cancel();
    await expect.poll(() => Object.values(pids).some(pidIsRunning), { timeout: 5_000 }).toBe(false);
    // The provider waits up to five seconds for a stopped app server to finish
    // the interrupted turn before it fails the stream.
    await settled;
    expect(Date.now() - cancelledAt).toBeLessThan(10_000);
  } finally {
    run.cancel();
  }
}, 30_000);

test("a Codex turn that finishes leaves nothing running", async () => {
  installFakeCodex("done");
  const { step, started } = startStep(cancellableRun());

  await expect(step).resolves.toMatchObject({ text: "done" });

  const pids = await started();
  await expect.poll(() => Object.values(pids).some(pidIsRunning), { timeout: 5_000 }).toBe(false);
}, 30_000);

test("a factory step streaming from Codex fails with the cancellation, not the provider's error", async () => {
  installFakeCodex(undefined);
  const run = cancellableRun();
  const { worktree, seams, started } = codexSetup(run);
  const runner = forFactoryStep(
    await openAgentRunner(
      harnesses.codex({ model: "gpt-5.5" }),
      { cwd: worktree, run: { workflowRunId: "codex-factory-cancel" } },
      seams,
    ),
  );
  try {
    const result = streamText({ model: runner.model, prompt: "Wait.", onError: () => {} });
    const text = expect(result.text).rejects.toSatisfy(
      (error) => error instanceof RunCancelledError && FatalError.is(error),
    );
    const pids = await started();

    run.cancel();
    await text;
    await expect.poll(() => pidIsRunning(pids.server), { timeout: 5_000 }).toBe(false);
  } finally {
    run.cancel();
    await runner.close();
  }
}, 30_000);
