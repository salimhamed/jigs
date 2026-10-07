import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { z } from "zod";
import { type ClaudeHarness, harnesses } from "../../../workflow/agents/harness-config.ts";
import { buildAgentRequest, buildAskAgentRequest } from "../../../workflow/agents/plan.ts";
import { harnessEnv } from "../shared/env.ts";
import { executeAgent } from "../shared/execute-agent.ts";
import {
  assertLivePreconditions,
  MARKER_PROMPT,
  makeMarkerSkill,
  makeScratchRepo,
} from "../shared/live-env.ts";
import { makeTmpDir, removeTmpDir } from "../shared/test-fixtures.ts";
import { CLAUDE_ENV, claudeStepSettings } from "./process.ts";

// Outside a factory there is no jigs.config.ts declaring agent variables.
vi.mock("../shared/env.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/env.ts")>()),
  factoryAgentEnv: () => [],
}));
// Outside a factory there is no registry to record the skills plugin's folder in.
vi.mock("../../runtime/registry.ts", () => ({ recordRunDirectory: async () => {} }));
// Outside a run there is no World status to watch; the run stays running.
vi.mock("../../../run-cancellation.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../run-cancellation.ts")>()),
  worldRunStatus: {
    read: async () => "running",
    waitForTerminal: (_runId: string, timeoutMs: number) =>
      new Promise((resolve) => setTimeout(() => resolve("running"), timeoutMs).unref()),
  },
}));

let tmp: string;
const savedDataHome = process.env.XDG_DATA_HOME;
beforeAll(() => {
  assertLivePreconditions();
  tmp = makeTmpDir();
  // The step's worktree lock goes under the test's own data dir.
  process.env.XDG_DATA_HOME = path.join(tmp, "data");
});
afterAll(() => {
  removeTmpDir(tmp);
  if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedDataHome;
});

const metadata = () => ({ workflowRunId: `live-claude-${crypto.randomUUID()}` });

async function agentStep(request: Parameters<typeof buildAgentRequest>[0]) {
  const result = await executeAgent(buildAgentRequest(request), metadata());
  if (!("text" in result)) throw new Error(`the step did not run: ${JSON.stringify(result)}`);
  return result;
}

const writeProbe = (codeword: string) =>
  `Write a file live-probe.txt at the repo root containing exactly "${codeword}" on one line, then confirm what you wrote.`;

test("Claude Code smoke: subscription auth drives an agentic query, no API keys", async () => {
  const env = harnessEnv(CLAUDE_ENV);
  expect("ANTHROPIC_API_KEY" in env).toBe(false);
  const scratch = makeScratchRepo(tmp);
  const codeword = `JIGS-LIVE-${crypto.randomUUID().slice(0, 8)}`;

  const settings = claudeStepSettings({
    model: "haiku",
    cwd: scratch,
    env,
    strictMcpConfig: true,
    settingSources: ["project"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  });
  let sessionId: string | undefined;
  try {
    for await (const message of query({ prompt: writeProbe(codeword), options: settings })) {
      if (message.type === "result") {
        expect(message.is_error).toBe(false);
        sessionId = message.session_id;
        break;
      }
    }
  } finally {
    await settings.spawnClaudeCodeProcess.close();
  }

  const probeFile = path.join(scratch, "live-probe.txt");
  expect(existsSync(probeFile)).toBe(true);
  expect(readFileSync(probeFile, "utf8").trim()).toBe(codeword);
  expect(sessionId).toBeTruthy();
});

test("the agent step passes the Claude smoke with descriptor settings and resumes its session", async () => {
  const scratch = makeScratchRepo(tmp, "step-smoke");
  const codeword = `JIGS-STEP-${crypto.randomUUID().slice(0, 8)}`;
  const harness: ClaudeHarness = harnesses.claude({
    model: "haiku",
    maxTurns: 10,
    allowedTools: ["Read", "Write"],
  });

  const { session } = await agentStep({ harness, cwd: scratch, prompt: writeProbe(codeword) });

  expect(readFileSync(path.join(scratch, "live-probe.txt"), "utf8").trim()).toBe(codeword);
  expect(session).toMatchObject({ harness: "claude", id: expect.any(String) });

  const resumed = await agentStep({
    harness,
    cwd: scratch,
    prompt: "Reply with only the codeword you wrote earlier, nothing else.",
    resume: session,
  });
  expect(resumed).toMatchObject({ text: expect.stringContaining(codeword), session });
});

test("maxTurns: 1 reaches the CLI: a task that needs a tool stops after one turn", async () => {
  const scratch = makeScratchRepo(tmp, "step-max-turns");

  await expect(
    agentStep({
      harness: harnesses.claude({ model: "haiku", maxTurns: 1 }),
      cwd: scratch,
      prompt:
        "Write a file one.txt containing 1, then read it back, then write two.txt containing 2, then confirm both.",
    }),
  ).rejects.toThrow("Reached maximum number of turns (1)");
  expect(existsSync(path.join(scratch, "two.txt"))).toBe(false);
});

test("a declared skill reaches an agent in a plain directory and its plugin is removed", async () => {
  const directory = path.join(tmp, "run-directory");
  mkdirSync(directory);
  const { folder, token } = makeMarkerSkill(tmp);

  const run = metadata();
  await executeAgent(
    buildAgentRequest({
      harness: harnesses.claude({ model: "haiku", maxTurns: 10, skills: [folder] }),
      cwd: directory,
      prompt: MARKER_PROMPT,
    }),
    run,
  );

  expect(readFileSync(path.join(directory, "skill-marker.txt"), "utf8").trim()).toBe(token);
  const runFolder = path.join(tmp, "data", "jigs", "claude-plugins", run.workflowRunId);
  expect(readdirSync(runFolder)).toEqual([]);
});

test("a structured ask and a structured run answer through Claude Code's output format", async () => {
  const output = z.object({ sum: z.number() });
  const asked = await executeAgent(
    buildAskAgentRequest({
      harness: harnesses.claude({ model: "haiku" }),
      system: "Answer arithmetic questions.",
      prompt: "What is 2 + 3?",
      output,
    }),
    metadata(),
  );
  expect(asked).toMatchObject({ output: { sum: 5 } });

  const ran = await agentStep({
    harness: harnesses.claude({ model: "haiku", maxTurns: 5 }),
    cwd: makeScratchRepo(tmp, "step-structured"),
    prompt: "What is 4 + 4? Do not use any tools.",
    output,
  });
  expect(ran).toMatchObject({ output: { sum: 8 } });
});
