import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { inTestFactory } from "../../../test-fixtures.ts";
import type { TurnRequest } from "../../../workflow/agents/conversation.ts";
import { type Harness, harnesses } from "../../../workflow/agents/harness-config.ts";
import { createClaudeDriver } from "../claude/driver.ts";
import { fakeClaudeCli } from "../claude/test-fixtures.ts";
import { drivers } from "./drivers.ts";
import { executeTurnWith } from "./execute-turn.ts";
import type { ExecutionSeams } from "./seams.ts";
import type { AgentStreamPart, StepStream } from "./step-stream.ts";
import { factorylessDeps, makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

let tmp: string;
let worktree: string;
beforeAll(() => {
  tmp = makeTmpDir();
  worktree = path.join(tmp, "worktree");
  mkdirSync(worktree);
  vi.stubEnv("JIGS_CLAUDE_EXECUTABLE", "/fake/claude");
  // The turn takes the worktree lock under the jigs data dir.
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
});
afterAll(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

inTestFactory();

function seams(cli = fakeClaudeCli(), stream?: StepStream): ExecutionSeams {
  const claude = createClaudeDriver({
    query: cli.query,
    transcript: async () => new Set(),
    openStepStream: () => undefined,
  });
  const resolve = (kind: keyof typeof drivers) => (kind === "claude" ? claude : drivers[kind]);
  return {
    ...factorylessDeps,
    resolveDriver: resolve as ExecutionSeams["resolveDriver"],
    openStepStream: () => stream,
    jitFailures: async () => undefined,
  };
}

const turn = (harness: Harness = harnesses.claude({ model: "haiku" })): TurnRequest => ({
  harness,
  cwd: worktree,
  conversation: `test:turn:${crypto.randomUUID()}`,
  messages: [{ uuid: "m1", author: "Salim Hamed", text: "hello" }],
});

const metadata = { workflowRunId: "wrun_turn" };

test("a conversation on a harness that cannot hold one fails before launching", async () => {
  const cli = fakeClaudeCli();
  await expect(
    executeTurnWith(turn(harnesses.codex({ model: "gpt-5.5" })), metadata, [], seams(cli)),
  ).rejects.toThrow("Codex cannot hold a conversation; run it on a Claude harness");
});

test("observers that throw or reject never fail the turn", async () => {
  const seen: string[] = [];
  const result = await executeTurnWith(
    turn(),
    metadata,
    [
      () => {
        throw new Error("sink down");
      },
      async () => {
        throw new Error("sink down later");
      },
      (event) => {
        seen.push(event.type);
      },
    ],
    seams(),
  );
  expect(result.outcome).toBe("finished");
  expect(seen).toEqual(["start", "part", "reply"]);
});

test("the turn's activity reaches the step stream", async () => {
  const records: AgentStreamPart[] = [];
  const stream: StepStream = {
    attempt: 1,
    writable: new WritableStream({
      write(record) {
        records.push(record);
      },
    }),
  };
  await executeTurnWith(turn(), metadata, [], seams(fakeClaudeCli(), stream));
  expect(records).toEqual([
    { type: "attempt-start", attempt: 1, harness: "claude", cwd: worktree, resume: false },
    expect.objectContaining({ type: "tool-call", toolName: "Bash" }),
    { type: "finish", finishReason: "stop" },
  ]);
});
