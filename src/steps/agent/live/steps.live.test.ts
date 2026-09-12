import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { claude, codex } from "../../../blocks/agent/harness-config.ts";
import { type AgentWire, buildAgentWire, buildAskWire } from "../../../blocks/agent/plan.ts";
import type { AgentStepResult, StepUsage } from "../../../blocks/agent/result.ts";
import { ensureManagedCodexHome } from "../harnesses/codex-home.ts";
import { stripApiCredentials } from "../harnesses/env.ts";
import { assertLivePreconditions, makeScratchRepo } from "../harnesses/live/fixtures/live-env.ts";
import { makeTmpDir, removeTmpDir } from "../harnesses/test-fixtures.ts";
import { type ExecuteDeps, executeAgent, realDeps } from "../run-agent.ts";
import { executeModelRequest } from "../run-ask.ts";

let tmp: string;
let deps: ExecuteDeps;
beforeAll(() => {
  assertLivePreconditions();
  stripApiCredentials();
  tmp = makeTmpDir();
  deps = {
    ...realDeps,
    // Managed homes under the test tmp dir, not ~/.local/share.
    ensureCodexHome: (runId) =>
      ensureManagedCodexHome(runId, {
        baseDir: path.join(tmp, "codex-homes"),
      }),
  };
});
afterAll(() => {
  removeTmpDir(tmp);
});

const verdict = z.object({
  ok: z.boolean(),
  word: z.string(),
});

const STRUCTURED_PROMPT =
  "Answer as structured output: set ok to true and word to exactly 'sky'. Do not create or modify any files.";

function assertUsage(usage: StepUsage | undefined): void {
  expect(usage).toBeDefined();
  expect(usage?.outputTokens ?? 0).toBeGreaterThan(0);
}

// executeAgent answers a union; a step that declares no MCP servers and carries
// no resume pointer can only take the successful arm.
async function runAgent(wire: AgentWire, runId: string): Promise<AgentStepResult<unknown>> {
  const result = await executeAgent(wire, { workflowRunId: runId }, deps);
  if ("jitFailure" in result) {
    throw new Error(`unexpected JIT failure: ${JSON.stringify(result.jitFailure)}`);
  }
  if ("resumeFailed" in result) {
    throw new Error(`unexpected resume failure: ${result.resumeFailed}`);
  }
  return result;
}

test("claude agent step: structured output round-trips typed, usage and session captured", async () => {
  const runId = `live-steps-claude-${crypto.randomUUID().slice(0, 8)}`;
  const wire = buildAgentWire({
    harness: claude({ model: "sonnet" }),
    cwd: makeScratchRepo(tmp, "claude-agent"),
    prompt: STRUCTURED_PROMPT,
    output: verdict,
  });

  const result = await runAgent(wire, runId);
  const parsed = verdict.parse(result.output);

  expect(parsed).toEqual({ ok: true, word: "sky" });
  assertUsage(result.usage);
  expect(result.session?.harness).toBe("claude");
  expect(result.session?.id).toBeTruthy();
});

test("codex agent step: structured output round-trips typed, usage and threadId captured", async () => {
  const runId = `live-steps-codex-${crypto.randomUUID().slice(0, 8)}`;
  const wire = buildAgentWire({
    harness: codex({ model: "gpt-5.5" }),
    cwd: makeScratchRepo(tmp, "codex-agent"),
    prompt: STRUCTURED_PROMPT,
    output: verdict,
  });

  const result = await runAgent(wire, runId);
  const parsed = verdict.parse(result.output);

  expect(parsed).toEqual({ ok: true, word: "sky" });
  assertUsage(result.usage);
  expect(result.session?.harness).toBe("codex");
  expect(result.session?.id).toBeTruthy();
});

test("claude ask step: structured output round-trips typed with usage", async () => {
  const runId = `live-steps-ask-claude-${crypto.randomUUID().slice(0, 8)}`;
  const wire = buildAskWire({
    harness: claude({ model: "sonnet" }),
    prompt: STRUCTURED_PROMPT,
    output: verdict,
  });

  const result = await executeModelRequest(wire, { workflowRunId: runId }, deps);

  expect(verdict.parse(result.output)).toEqual({ ok: true, word: "sky" });
  assertUsage(result.usage);
});

test("codex ask step: structured output round-trips typed with usage", async () => {
  const runId = `live-steps-ask-codex-${crypto.randomUUID().slice(0, 8)}`;
  const wire = buildAskWire({
    harness: codex({ model: "gpt-5.5" }),
    prompt: STRUCTURED_PROMPT,
    output: verdict,
  });

  const result = await executeModelRequest(wire, { workflowRunId: runId }, deps);

  expect(verdict.parse(result.output)).toEqual({ ok: true, word: "sky" });
  assertUsage(result.usage);
});
