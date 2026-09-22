import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { harnesses } from "../../../blocks/agents/harness-config.ts";
import {
  type AgentRequest,
  buildAgentRequest,
  buildAskAgentRequest,
} from "../../../blocks/agents/plan.ts";
import type { AgentResult } from "../../../blocks/agents/result.ts";
import { createCodexDriver } from "../drivers/codex.ts";
import { withCodexAppServer } from "../drivers/codex-support.ts";
import { type DriverResolver, driverFor } from "../drivers/index.ts";
import {
  type AgentExecutionDependencies,
  defaultAgentExecutionDependencies,
  executeAgent,
} from "../execute-agent.ts";
import { ensureManagedCodexHome } from "../harnesses/codex-home.ts";
import { stripApiCredentials } from "../harnesses/env.ts";
import { assertLivePreconditions, makeScratchRepo } from "../harnesses/live/fixtures/live-env.ts";
import { makeTmpDir, removeTmpDir } from "../harnesses/test-fixtures.ts";

let tmp: string;
let deps: AgentExecutionDependencies;
beforeAll(() => {
  assertLivePreconditions();
  stripApiCredentials();
  tmp = makeTmpDir();
  const codex = createCodexDriver({
    ensureCodexHome: (runId) =>
      ensureManagedCodexHome(runId, {
        baseDir: path.join(tmp, "codex-homes"),
      }),
    withCodexAppServer,
  });
  deps = {
    ...defaultAgentExecutionDependencies,
    // Managed homes under the test tmp dir, not ~/.local/share.
    resolveDriver: ((kind) => (kind === "codex" ? codex : driverFor(kind))) as DriverResolver,
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

// executeAgent answers a union; a step that declares no MCP servers and carries
// no resume pointer can only take the successful arm.
async function runAgent(wire: AgentRequest, runId: string): Promise<AgentResult<unknown>> {
  const result = await executeAgent(wire, { workflowRunId: runId }, deps);
  if ("jitFailure" in result) {
    throw new Error(`unexpected JIT failure: ${JSON.stringify(result.jitFailure)}`);
  }
  if ("resumeFailed" in result) {
    throw new Error(`unexpected resume failure: ${result.resumeFailed}`);
  }
  return result;
}

test("claude agent step: structured output round-trips typed, session captured", async () => {
  const runId = `live-steps-claude-${crypto.randomUUID().slice(0, 8)}`;
  const wire = buildAgentRequest({
    harness: harnesses.claude("haiku"),
    cwd: makeScratchRepo(tmp, "claude-agent"),
    prompt: STRUCTURED_PROMPT,
    output: verdict,
  });

  const result = await runAgent(wire, runId);
  const parsed = verdict.parse(result.output);

  expect(parsed).toEqual({ ok: true, word: "sky" });
  expect(result.session?.harness).toBe("claude");
  expect(result.session?.id).toBeTruthy();
});

test("codex agent step: structured output round-trips typed, threadId captured", async () => {
  const runId = `live-steps-codex-${crypto.randomUUID().slice(0, 8)}`;
  const wire = buildAgentRequest({
    harness: harnesses.codex("gpt-5.6-luna"),
    cwd: makeScratchRepo(tmp, "codex-agent"),
    prompt: STRUCTURED_PROMPT,
    output: verdict,
  });

  const result = await runAgent(wire, runId);
  const parsed = verdict.parse(result.output);

  expect(parsed).toEqual({ ok: true, word: "sky" });
  expect(result.session?.harness).toBe("codex");
  expect(result.session?.id).toBeTruthy();
});

test("claude ask step: structured output round-trips typed", async () => {
  const runId = `live-steps-ask-claude-${crypto.randomUUID().slice(0, 8)}`;
  const wire = buildAskAgentRequest({
    harness: harnesses.claude("haiku"),
    prompt: STRUCTURED_PROMPT,
    output: verdict,
  });

  const result = await runAgent(wire, runId);

  expect(verdict.parse(result.output)).toEqual({ ok: true, word: "sky" });
});

test("codex ask step: structured output round-trips typed", async () => {
  const runId = `live-steps-ask-codex-${crypto.randomUUID().slice(0, 8)}`;
  const wire = buildAskAgentRequest({
    harness: harnesses.codex("gpt-5.6-luna"),
    prompt: STRUCTURED_PROMPT,
    output: verdict,
  });

  const result = await runAgent(wire, runId);

  expect(verdict.parse(result.output)).toEqual({ ok: true, word: "sky" });
});
