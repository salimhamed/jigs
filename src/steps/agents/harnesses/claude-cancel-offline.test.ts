import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FatalError } from "workflow";
import { harnesses } from "../../../workflow/agents/harness-config.ts";
import { buildAgentRequest, buildAskAgentRequest } from "../../../workflow/agents/plan.ts";
import { claudeProcessSpawner } from "../drivers/claude-support.ts";
import { executeAgentWith } from "../execute-agent.ts";
import { RunCancelledError } from "../run-cancellation.ts";
import { executionSeams } from "../seams.ts";
import { isTrackedProcessGroup } from "./process-group.ts";
import { cancellableRun, makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

const skipOnWindows = process.platform === "win32";

// Speaks just enough of Claude Code's stream-json protocol for the provider.
// `hang` starts a child that ignores SIGTERM and never answers the turn;
// `linger` answers, then leaves such a child behind when it exits; `escape`
// answers after starting a child in a new session that holds its stdout.
const fakeClaude = `#!${process.execPath}
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const mode = process.env.JIGS_TEST_CLAUDE_MODE;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const ignoringTerm = () =>
  spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });
const record = (child) =>
  writeFileSync(
    process.env.JIGS_TEST_CLAUDE_PIDS,
    JSON.stringify({ leader: process.pid, child: child?.pid }),
  );
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({
      type: "control_response",
      response: { subtype: "success", request_id: message.request_id, response: {} },
    });
    return;
  }
  if (message.type !== "user") return;
  send({ type: "system", subtype: "init", session_id: "fake-session", cwd: process.cwd(), tools: [], mcp_servers: [] });
  if (mode === "hang") return record(ignoringTerm());
  if (mode === "escape") {
    const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: ["ignore", "inherit", "ignore"],
    });
    escaped.unref();
    record(escaped);
  }
  else record(mode === "linger" ? ignoringTerm() : undefined);
  send({
    type: "assistant",
    session_id: "fake-session",
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
  });
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: "fake-session",
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
});
`;

let tmp: string;
let worktree: string;
let pidFile: string;
let executable: string;

beforeEach(() => {
  tmp = makeTmpDir();
  worktree = path.join(tmp, "worktree");
  mkdirSync(worktree);
  pidFile = path.join(tmp, "pids.json");
  executable = path.join(tmp, "claude");
  writeFileSync(executable, fakeClaude);
  chmodSync(executable, 0o755);
  vi.stubEnv("JIGS_CLAUDE_EXECUTABLE", executable);
  vi.stubEnv("JIGS_TEST_CLAUDE_PIDS", pidFile);
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recorded(): { leader: number; child?: number } {
  return JSON.parse(readFileSync(pidFile, "utf8"));
}

async function started(): Promise<{ leader: number; child: number }> {
  await expect
    .poll(() => {
      try {
        return recorded().child;
      } catch {
        return undefined;
      }
    })
    .toBeTypeOf("number");
  return recorded() as { leader: number; child: number };
}

function step(mode: string, request: Parameters<typeof executeAgentWith>[0]) {
  vi.stubEnv("JIGS_TEST_CLAUDE_MODE", mode);
  const run = cancellableRun();
  const settled = executeAgentWith(
    request,
    { workflowRunId: `claude-${mode}` },
    {
      ...executionSeams,
      runStatus: run,
      factoryEnv: () => ["JIGS_TEST_CLAUDE_PIDS", "JIGS_TEST_CLAUDE_MODE"],
      jitFailures: async () => undefined,
    },
  );
  return { run, settled };
}

const claude = harnesses.claude({ model: "sonnet" });

test.skipIf(skipOnWindows)(
  "cancelling the run stops Claude Code and a child that ignores SIGTERM before the step settles",
  async () => {
    const { run, settled } = step(
      "hang",
      buildAgentRequest({ harness: claude, cwd: worktree, prompt: "work" }),
    );
    const rejected = expect(settled).rejects.toSatisfy(
      (error) => error instanceof RunCancelledError && FatalError.is(error),
    );
    const { leader, child } = await started();
    expect(pidIsRunning(child)).toBe(true);
    const cancelledAt = Date.now();

    run.cancel();
    await rejected;

    expect(Date.now() - cancelledAt).toBeLessThan(5_000);
    expect(pidIsRunning(leader)).toBe(false);
    expect(pidIsRunning(child)).toBe(false);
    expect(isTrackedProcessGroup(leader)).toBe(false);
  },
  20_000,
);

test.skipIf(skipOnWindows)(
  "cancelling the run stops a Claude Code ask and its child",
  async () => {
    const { run, settled } = step(
      "hang",
      buildAskAgentRequest({ harness: claude, prompt: "answer" }),
    );
    const rejected = expect(settled).rejects.toSatisfy(
      (error) => error instanceof RunCancelledError && FatalError.is(error),
    );
    const { leader, child } = await started();

    run.cancel();
    await rejected;

    expect(pidIsRunning(leader)).toBe(false);
    expect(pidIsRunning(child)).toBe(false);
    expect(isTrackedProcessGroup(leader)).toBe(false);
  },
  20_000,
);

test.skipIf(skipOnWindows)(
  "a completed Claude Code step and ask leave no process or group behind",
  async () => {
    for (const request of [
      buildAgentRequest({ harness: claude, cwd: worktree, prompt: "work" }),
      buildAskAgentRequest({ harness: claude, prompt: "answer" }),
    ]) {
      const { settled } = step("answer", request);
      await expect(settled).resolves.toMatchObject({ text: "done" });
      const { leader } = recorded();
      expect(pidIsRunning(leader)).toBe(false);
      expect(isTrackedProcessGroup(leader)).toBe(false);
    }
  },
  20_000,
);

test.skipIf(skipOnWindows)(
  "a child Claude Code leaves behind when it exits is stopped before the step settles",
  async () => {
    const { settled } = step(
      "linger",
      buildAgentRequest({ harness: claude, cwd: worktree, prompt: "work" }),
    );
    await expect(settled).resolves.toMatchObject({ text: "done" });
    const { leader, child } = recorded();
    expect(child).toBeTypeOf("number");
    expect(pidIsRunning(child as number)).toBe(false);
    expect(isTrackedProcessGroup(leader)).toBe(false);
  },
  20_000,
);

for (const how of ["the SDK's kill", "the SDK's abort signal"] as const) {
  test.skipIf(skipOnWindows)(
    `${how} stops the whole group and reports the exit only once it is gone`,
    async () => {
      const sdkAbort = new AbortController();
      const spawner = claudeProcessSpawner(
        {
          PATH: process.env.PATH ?? "",
          JIGS_TEST_CLAUDE_PIDS: pidFile,
          JIGS_TEST_CLAUDE_MODE: "hang",
        },
        { host: {} },
      );
      const launched = spawner({
        command: executable,
        args: [],
        cwd: worktree,
        env: {},
        signal: sdkAbort.signal,
      });
      launched.stdin.write(`${JSON.stringify({ type: "user" })}\n`);
      const { leader, child } = await started();
      const exit = new Promise<[number | null, NodeJS.Signals | null, boolean]>((resolve) =>
        launched.once("exit", (code, signal) => resolve([code, signal, pidIsRunning(child)])),
      );

      if (how === "the SDK's kill") launched.kill("SIGTERM");
      else sdkAbort.abort();

      await expect(exit).resolves.toEqual([null, "SIGTERM", false]);
      expect(launched.signalCode).toBe("SIGTERM");
      expect(pidIsRunning(leader)).toBe(false);
      expect(isTrackedProcessGroup(leader)).toBe(false);
      await spawner.close();
    },
    20_000,
  );
}

test.skipIf(skipOnWindows)(
  "a Claude Code that exits while a process outside its group holds stdout still reports its exit",
  async () => {
    const spawner = claudeProcessSpawner(
      {
        PATH: process.env.PATH ?? "",
        JIGS_TEST_CLAUDE_PIDS: pidFile,
        JIGS_TEST_CLAUDE_MODE: "escape",
      },
      { host: {} },
    );
    const launched = spawner({
      command: executable,
      args: [],
      cwd: worktree,
      env: {},
      signal: new AbortController().signal,
    });
    const exit = new Promise((resolve) => launched.once("exit", resolve));
    launched.stdin.end(`${JSON.stringify({ type: "user" })}\n`);
    const { leader, child: escaped } = await started();
    try {
      await expect.poll(() => pidIsRunning(leader)).toBe(false);
      expect(pidIsRunning(escaped)).toBe(true);
      const exitedAt = Date.now();

      launched.kill("SIGTERM");
      await spawner.close();
      await exit;

      expect(Date.now() - exitedAt).toBeLessThan(1_000);
      expect(isTrackedProcessGroup(leader)).toBe(false);
    } finally {
      process.kill(escaped, "SIGKILL");
    }
  },
  20_000,
);
