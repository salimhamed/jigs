import path from "node:path";
import { createCodexAppServer } from "ai-sdk-provider-codex-cli";
import { afterAll, beforeAll, expect, test } from "vitest";
import { harnesses } from "../../../../workflow/agents/harness-config.ts";
import { buildAgentRequest } from "../../../../workflow/agents/plan.ts";
import { createCodexDriver } from "../../drivers/codex.ts";
import { type DriverResolver, driverFor } from "../../drivers/index.ts";
import { executeAgentWith } from "../../execute-agent.ts";
import { type ExecutionSeams, executionSeams } from "../../seams.ts";
import { codexSessionFile, prepareCodexInvocationHome } from "../codex-home.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { assertLivePreconditions, makeScratchRepo } from "./fixtures/live-env.ts";

// The staleness half of the resume contract, against the real harnesses: a
// session reference that names nothing must surface as the resumeFailed marker,
// never as a thrown step (which the SDK would retry three times) and never as
// a silently fresh session pretending to hold the context.

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
    resolveDriver: ((kind) => (kind === "codex" ? codex : driverFor(kind))) as DriverResolver,
  };
});
afterAll(() => {
  removeTmpDir(tmp);
});

test("a codex thread id with no rollout behind it reports resumeFailed", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.codex({ model: "gpt-5.5" }),
    cwd: makeScratchRepo(tmp, "codex-resume"),
    prompt: "Reply with exactly OK and nothing else.",
    resume: { harness: "codex", id: `0199${crypto.randomUUID().slice(4)}`, descriptor: "" },
  });

  const result = await executeAgentWith(wire, { workflowRunId: "live-codex-resume" }, deps);

  expect(result).toHaveProperty("resumeFailed");
  // codex 0.149.1 raises a raw JSON-RPC error that does not match the
  // provider's /thread.*not found/i wrapper, so nothing in jigs may key off an
  // error string.
  const { resumeFailed } = result as { resumeFailed: string };
  expect(resumeFailed).not.toMatch(/thread.*not found/i);
});

test("a claude session id with no transcript behind it reports resumeFailed", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: makeScratchRepo(tmp, "claude-resume"),
    prompt: "Reply with exactly OK and nothing else.",
    resume: { harness: "claude", id: crypto.randomUUID(), descriptor: "" },
  });

  const result = await executeAgentWith(wire, { workflowRunId: "live-claude-resume" }, deps);

  expect(result).toHaveProperty("resumeFailed");
});
