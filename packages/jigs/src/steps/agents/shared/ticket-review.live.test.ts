import path from "node:path";
import { createCodexAppServer } from "ai-sdk-provider-codex-cli";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { RunAgentFn } from "../../../workflow/agents/agent-session.ts";
import { harnesses } from "../../../workflow/agents/harness-config.ts";
import {
  buildAgentRequest,
  parseOutput,
  type RunAgentOptions,
} from "../../../workflow/agents/plan.ts";
import { ticketReviewVerdictSchema } from "../../../workflow/linear/review.ts";
import { renderTicketSnapshot, type TicketSnapshot } from "../../../workflow/linear/snapshot.ts";
import { ticketReviewPrompt } from "../../../workflow/linear/ticket-review.prompt.ts";
import { createCodexDriver } from "../codex/driver.ts";
import { codexSessionFile, prepareCodexInvocationHome } from "../codex/home.ts";
import { type DriverResolver, driverFor } from "./drivers.ts";
import { executeAgentWith } from "./execute-agent.ts";
import { assertLivePreconditions } from "./live-env.ts";
import { type ExecutionSeams, executionSeams } from "./seams.ts";
import { makeTmpDir, removeTmpDir, runningRunStatus } from "./test-fixtures.ts";

let tmp: string;
let deps: ExecutionSeams;

beforeAll(() => {
  assertLivePreconditions();
  tmp = makeTmpDir();
  const codex = createCodexDriver({
    prepareCodexHome: async (runId) =>
      prepareCodexInvocationHome(runId, { baseDir: path.join(tmp, "codex-homes") }),
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
afterAll(() => removeTmpDir(tmp));

const snapshot: TicketSnapshot = {
  fetchedAt: "2026-09-16T00:00:00Z",
  id: "age-435-eval",
  identifier: "AGE-435-EVAL",
  title: "Choose the merge-policy mismatch behavior",
  description: `The implementation is blocked on three independent product decisions.

1. Should a merge-policy mismatch be reported as a warning or an error?
2. Should doctor print only a summary or also print the mismatched settings?
3. Should bind succeed or fail when it finds a mismatch?

Do not infer these choices. A human must decide all three before implementation starts.`,
  url: "https://linear.example/AGE-435-EVAL",
  branchName: "age-435-eval",
  state: "Todo",
  labels: [],
  comments: [],
  blockedBy: [],
  blocks: [],
  links: [],
  subIssues: [],
};

const answeredSnapshot: TicketSnapshot = {
  ...snapshot,
  fetchedAt: "2026-09-16T00:01:00Z",
  comments: [
    {
      id: "answer-1",
      author: "Product owner",
      createdAt: "2026-09-16T00:01:00Z",
      body: "Settled answers: report a warning; doctor prints the mismatched settings; bind succeeds on a mismatch.",
    },
  ],
};

test("ticket review asks every knowable decision in one needs-human round", async () => {
  const runId = `live-ticket-review-${crypto.randomUUID().slice(0, 8)}`;
  const runAgent: RunAgentFn = async <T>(config: RunAgentOptions<T>) => {
    const result = await executeAgentWith(
      buildAgentRequest(config),
      { workflowRunId: runId },
      deps,
    );
    if ("jitFailure" in result || "resumeFailed" in result)
      throw new Error("unexpected agent marker");
    return {
      ...result,
      output: parseOutput(config.output, result.output),
    };
  };

  const review = (ticket: TicketSnapshot) =>
    runAgent({
      harness: harnesses.codex({ model: "gpt-5.5" }),
      cwd: "/tmp",
      prompt: ticketReviewPrompt({ ticket: renderTicketSnapshot(ticket) }),
      output: ticketReviewVerdictSchema,
    });

  const first = await review(snapshot);
  expect(first.output.verdict).toBe("needs-human");
  const rendered = JSON.stringify(first.output.questions).toLowerCase();
  expect(rendered).toMatch(/warning|error/);
  expect(rendered).toMatch(/doctor/);
  expect(rendered).toMatch(/bind/);

  // Every decision was asked in the first round, so the answers are enough to proceed.
  const second = await review(answeredSnapshot);
  expect(second.output.verdict).toBe("proceed");
});
