import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { harnesses } from "../../../../blocks/agents/harness-config.ts";
import { buildAgentRequest } from "../../../../blocks/agents/plan.ts";
import { createCodexDriver } from "../../drivers/codex.ts";
import { withCodexAppServer } from "../../drivers/codex-support.ts";
import { type DriverResolver, driverFor } from "../../drivers/index.ts";
import {
  type AgentExecutionDependencies,
  defaultAgentExecutionDependencies,
  executeAgent,
} from "../../execute-agent.ts";
import { codexSessionFile, prepareCodexInvocationHome } from "../codex-home.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { assertLivePreconditions, makeScratchRepo } from "./fixtures/live-env.ts";

// The staleness half of the resume contract, against the real harnesses: a
// session pointer that names nothing must surface as the resumeFailed marker,
// never as a thrown step (which the SDK would retry three times) and never as
// a silently fresh session pretending to hold the context.

let tmp: string;
let deps: AgentExecutionDependencies;
beforeAll(() => {
  assertLivePreconditions();
  tmp = makeTmpDir();
  const codex = createCodexDriver({
    prepareCodexHome: (runId) =>
      prepareCodexInvocationHome(runId, {
        baseDir: path.join(tmp, "codex-homes"),
      }),
    sessionFile: codexSessionFile,
    withCodexAppServer,
  });
  deps = {
    ...defaultAgentExecutionDependencies,
    factoryEnv: () => [],
    resolveDriver: ((kind) => (kind === "codex" ? codex : driverFor(kind))) as DriverResolver,
  };
});
afterAll(() => {
  removeTmpDir(tmp);
});

test("a codex thread id with no rollout behind it reports resumeFailed", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.codex("gpt-5.5"),
    cwd: makeScratchRepo(tmp, "codex-resume"),
    prompt: "Reply with exactly OK and nothing else.",
    resume: { harness: "codex", id: `0199${crypto.randomUUID().slice(4)}` },
  });

  const result = await executeAgent(wire, { workflowRunId: "live-codex-resume" }, deps);

  expect(result).toHaveProperty("resumeFailed");
  // codex 0.149.1 raises a raw JSON-RPC error that does not match the
  // provider's /thread.*not found/i wrapper, so nothing in jigs may key off an
  // error string.
  const { resumeFailed } = result as { resumeFailed: string };
  expect(resumeFailed).not.toMatch(/thread.*not found/i);
});

test("a claude session id with no transcript behind it reports resumeFailed", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude("sonnet"),
    cwd: makeScratchRepo(tmp, "claude-resume"),
    prompt: "Reply with exactly OK and nothing else.",
    resume: { harness: "claude", id: crypto.randomUUID() },
  });

  const result = await executeAgent(wire, { workflowRunId: "live-claude-resume" }, deps);

  expect(result).toHaveProperty("resumeFailed");
});
