import { readFileSync } from "node:fs";
import path from "node:path";
import { createCodexAppServer } from "ai-sdk-provider-codex-cli";
import { afterAll, beforeAll, expect, test } from "vitest";
import { harnesses } from "../../../workflow/agents/harness-config.ts";
import { buildAgentRequest } from "../../../workflow/agents/plan.ts";
import { type DriverResolver, driverFor } from "../shared/drivers.ts";
import { executeAgentWith } from "../shared/execute-agent.ts";
import {
  assertLivePreconditions,
  MARKER_PROMPT,
  makeMarkerSkill,
  makeScratchRepo,
} from "../shared/live-env.ts";
import { type ExecutionSeams, executionSeams } from "../shared/seams.ts";
import { makeTmpDir, removeTmpDir, runningRunStatus } from "../shared/test-fixtures.ts";
import { createCodexDriver } from "./driver.ts";
import { codexSessionFile, prepareCodexInvocationHome } from "./home.ts";

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
    prepareCodexHome: async (runId, skills) =>
      prepareCodexInvocationHome(runId, {
        baseDir: path.join(tmp, "codex-homes"),
        skills,
      }),
    sessionFile: codexSessionFile,
    createAppServer: () => createCodexAppServer(),
  });
  deps = {
    ...executionSeams,
    runStatus: runningRunStatus,
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

test("a declared skill reaches a Codex agent through its private home", async () => {
  const worktree = makeScratchRepo(tmp, "codex-skill");
  const { folder, token } = makeMarkerSkill(tmp);
  const wire = buildAgentRequest({
    harness: harnesses.codex({ model: "gpt-5.5", skills: [folder] }),
    cwd: worktree,
    prompt: MARKER_PROMPT,
  });

  const result = await executeAgentWith(wire, { workflowRunId: "live-codex-skill" }, deps);

  expect(result).not.toHaveProperty("jitFailure");
  expect(readFileSync(path.join(worktree, "skill-marker.txt"), "utf8").trim()).toBe(token);
});
