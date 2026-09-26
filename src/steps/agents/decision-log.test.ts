import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { models } from "../../workflow/agents/harness-config.ts";
import { choice } from "../../workflow/agents/jev.ts";
import { runDirectory } from "../runtime/run-directory/index.ts";
import { decisionLogPath } from "./decision-log.ts";
import { executeJevWith } from "./execute-model-request.ts";
import { executionSeams } from "./seams.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "jigs-decision-log-test-"));
  vi.stubEnv("XDG_DATA_HOME", root);
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const request = {
  model: models.openrouter("typesafe/jev-1.13"),
  site: "pull-request-wake",
  state: { ci: "pending" },
  questions: { decision: choice("What next?", { idle: "Wait", builder: "Act" }) },
};

const evaluate = async () => ({
  answers: {
    decision: {
      type: "choice" as const,
      choice: "idle",
      probabilities: { idle: 0.9, builder: 0.1 },
    },
  },
  providerMetadata: { openrouter: { answers: { decision: { confidence: 0.9 } } } },
});

test("an answered decision appends one line to the run's decision log", async () => {
  const metadata = { workflowRunId: "wrun_decisions" };
  await executeJevWith(request, metadata, { ...executionSeams, evaluate });
  await executeJevWith(request, metadata, { ...executionSeams, evaluate });

  const lines = (await readFile(decisionLogPath(metadata), "utf8")).trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0] ?? "")).toEqual({
    at: expect.any(String),
    site: "pull-request-wake",
    state: { ci: "pending" },
    questions: request.questions,
    answers: {
      decision: { choice: "idle", probabilities: { idle: 0.9, builder: 0.1 }, confidence: 0.9 },
    },
  });
});

test("a decision log that cannot be written leaves the decision intact", async () => {
  const metadata = { workflowRunId: "wrun_blocked" };
  await mkdir(path.dirname(runDirectory(metadata)), { recursive: true });
  await writeFile(runDirectory(metadata), "a file where the run directory belongs");

  const result = await executeJevWith(request, metadata, { ...executionSeams, evaluate });

  expect(result.answers.decision.choice).toBe("idle");
});

test("a decide call's rules record how each answer resolved", async () => {
  const metadata = { workflowRunId: "wrun_resolved" };
  await executeJevWith(
    { ...request, rules: { decision: { whenUnsure: "builder", cutoff: 0.95 } } },
    metadata,
    { ...executionSeams, evaluate },
  );

  const entry = JSON.parse((await readFile(decisionLogPath(metadata), "utf8")).trim());
  expect(entry.resolved).toEqual({
    decision: { value: "builder", confidence: 0.9, unsure: true },
  });
});
