import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { type ClaudeHarness, harnesses } from "../../../../workflow/agents/harness-config.ts";
import { CLAUDE_ENV, claudeStepSettings } from "../../drivers/claude-support.ts";
import { createAgentRunner } from "../../runner.ts";
import { harnessEnv } from "../env.ts";
import { claudeCode } from "../index.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { assertLivePreconditions, makeScratchRepo } from "./fixtures/live-env.ts";

// Outside a factory there is no jigs.config.ts declaring agent variables.
vi.mock("../env.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../env.ts")>()),
  factoryAgentEnv: () => [],
}));

let tmp: string;
const savedDataHome = process.env.XDG_DATA_HOME;
beforeAll(() => {
  assertLivePreconditions();
  tmp = makeTmpDir();
  // The runner's worktree lock goes under the test's own data dir.
  process.env.XDG_DATA_HOME = path.join(tmp, "data");
});
afterAll(() => {
  removeTmpDir(tmp);
  if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedDataHome;
});

// Shaped like a factory's own step, minus the directive this package never carries.
async function factoryStep(request: { harness: ClaudeHarness; cwd: string; prompt: string }) {
  const runner = await createAgentRunner(request.harness, {
    cwd: request.cwd,
    run: { workflowRunId: `live-runner-${crypto.randomUUID()}` },
  });
  try {
    const result = await generateText({ model: runner.model, prompt: request.prompt });
    return { result, session: runner.sessionFrom(result) };
  } finally {
    await runner.close();
  }
}

test("Claude Code smoke: subscription auth drives an agentic step, no API keys", async () => {
  const env = harnessEnv(CLAUDE_ENV);
  expect("ANTHROPIC_API_KEY" in env).toBe(false);
  const scratch = makeScratchRepo(tmp);
  const codeword = `JIGS-LIVE-${crypto.randomUUID().slice(0, 8)}`;

  const model = claudeCode(
    "haiku",
    claudeStepSettings({
      cwd: scratch,
      env,
      strictMcpConfig: true,
      settingSources: ["project"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    }),
  );
  const result = await generateText({
    model,
    prompt: `Write a file live-probe.txt at the repo root containing exactly "${codeword}" on one line, then confirm what you wrote.`,
  });

  const probeFile = path.join(scratch, "live-probe.txt");
  expect(existsSync(probeFile)).toBe(true);
  expect(readFileSync(probeFile, "utf8").trim()).toBe(codeword);

  const meta = result.providerMetadata?.["claude-code"] as { sessionId?: string } | undefined;
  expect(meta?.sessionId).toBeTruthy();
});

test("a factory-owned step on createAgentRunner passes the Claude smoke with descriptor settings", async () => {
  const scratch = makeScratchRepo(tmp, "runner-smoke");
  const codeword = `JIGS-RUNNER-${crypto.randomUUID().slice(0, 8)}`;

  const { session } = await factoryStep({
    harness: harnesses.claude({ model: "haiku", maxTurns: 10, allowedTools: ["Read", "Write"] }),
    cwd: scratch,
    prompt: `Write a file live-probe.txt at the repo root containing exactly "${codeword}" on one line, then confirm what you wrote.`,
  });

  expect(readFileSync(path.join(scratch, "live-probe.txt"), "utf8").trim()).toBe(codeword);
  expect(session).toMatchObject({ harness: "claude", id: expect.any(String) });
});

test("maxTurns: 1 reaches the CLI: a task that needs a tool stops after one turn", async () => {
  const scratch = makeScratchRepo(tmp, "runner-max-turns");

  // The CLI ends the session at the limit, and the provider reports it as an error.
  await expect(
    factoryStep({
      harness: harnesses.claude({ model: "haiku", maxTurns: 1 }),
      cwd: scratch,
      prompt:
        "Write a file one.txt containing 1, then read it back, then write two.txt containing 2, then confirm both.",
    }),
  ).rejects.toThrow("Reached maximum number of turns (1)");
  expect(existsSync(path.join(scratch, "two.txt"))).toBe(false);
});
