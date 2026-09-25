import path from "node:path";
import { createCodexAppServer } from "ai-sdk-provider-codex-cli";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { harnesses } from "../../../workflow/agents/harness-config.ts";
import {
  type AgentRequest,
  buildAgentRequest,
  buildAskAgentRequest,
} from "../../../workflow/agents/plan.ts";
import type { AgentResult } from "../../../workflow/agents/result.ts";
import { createCodexDriver } from "../drivers/codex.ts";
import { type DriverResolver, driverFor } from "../drivers/index.ts";
import { executeAgentWith } from "../execute-agent.ts";
import { codexSessionFile, prepareCodexInvocationHome } from "../harnesses/codex-home.ts";
import { assertLivePreconditions, makeScratchRepo } from "../harnesses/live/fixtures/live-env.ts";
import { makeTmpDir, removeTmpDir } from "../harnesses/test-fixtures.ts";
import { type ExecutionSeams, executionSeams } from "../seams.ts";

let tmp: string;
let deps: ExecutionSeams;
beforeAll(() => {
  assertLivePreconditions();
  tmp = makeTmpDir();
  const codex = createCodexDriver({
    prepareCodexHome: (runId) =>
      prepareCodexInvocationHome(runId, {
        baseDir: path.join(tmp, "codex-homes"),
      }),
    sessionFile: codexSessionFile,
    createAppServer: () => createCodexAppServer(),
  });
  deps = {
    ...executionSeams,
    factoryEnv: () => [],
    // Run state under the test tmp dir, not ~/.local/share.
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
// no session reference to resume can only take the successful arm.
async function runAgent(wire: AgentRequest, runId: string): Promise<AgentResult<unknown>> {
  const result = await executeAgentWith(wire, { workflowRunId: runId }, deps);
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
    harness: harnesses.claude({ model: "haiku" }),
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
    harness: harnesses.codex({ model: "gpt-5.6-luna" }),
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
    harness: harnesses.claude({ model: "haiku" }),
    prompt: STRUCTURED_PROMPT,
    output: verdict,
  });

  const result = await runAgent(wire, runId);

  expect(verdict.parse(result.output)).toEqual({ ok: true, word: "sky" });
});
