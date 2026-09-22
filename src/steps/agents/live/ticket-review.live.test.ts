import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { harnesses } from "../../../blocks/agents/harness-config.ts";
import {
  buildAskAgentRequest,
  parseOutput,
  type RunAgentOptions,
} from "../../../blocks/agents/plan.ts";
import type { RunAgentFn } from "../../../blocks/agents/resume-or-rebuild.ts";
import type { TicketClaim } from "../../../blocks/linear/claim.ts";
import type { HaltForHumanFn, HumanReply } from "../../../blocks/linear/halt-for-human.ts";
import { reviewTicket } from "../../../blocks/linear/review.ts";
import type { TicketSnapshot } from "../../../blocks/linear/snapshot.ts";
import { createCodexDriver } from "../drivers/codex.ts";
import { withCodexAppServer } from "../drivers/codex-support.ts";
import { type DriverResolver, driverFor } from "../drivers/index.ts";
import {
  type AgentExecutionDependencies,
  defaultAgentExecutionDependencies,
  executeAgent,
} from "../execute-agent.ts";
import { codexSessionFile, prepareCodexInvocationHome } from "../harnesses/codex-home.ts";
import { stripApiCredentials } from "../harnesses/env.ts";
import { assertLivePreconditions } from "../harnesses/live/fixtures/live-env.ts";
import { makeTmpDir, removeTmpDir } from "../harnesses/test-fixtures.ts";

let tmp: string;
let deps: AgentExecutionDependencies;

beforeAll(() => {
  assertLivePreconditions();
  stripApiCredentials();
  tmp = makeTmpDir();
  const codex = createCodexDriver({
    prepareCodexHome: (runId) =>
      prepareCodexInvocationHome(runId, { baseDir: path.join(tmp, "codex-homes") }),
    sessionFile: codexSessionFile,
    withCodexAppServer,
  });
  deps = {
    ...defaultAgentExecutionDependencies,
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
    const result = await executeAgent(
      buildAskAgentRequest({
        harness: config.harness,
        prompt: config.prompt,
        ...(config.output === undefined ? {} : { output: config.output }),
      }),
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

  const halts: string[] = [];
  const haltForHuman: HaltForHumanFn = async (_claim, halt): Promise<HumanReply> => {
    const rendered = JSON.stringify(halt.questions).toLowerCase();
    halts.push(rendered);
    if (halts.length > 1) throw new Error("ticket review emitted an avoidable second pause");

    expect(rendered).toMatch(/warning|error/);
    expect(rendered).toMatch(/doctor/);
    expect(rendered).toMatch(/bind/);
    return {
      commentId: "answer-1",
      body: answeredSnapshot.comments[0]?.body ?? "",
      author: { id: "owner-1", name: "Product owner" },
      createdAt: answeredSnapshot.comments[0]?.createdAt ?? "",
    };
  };

  const handoff = await reviewTicket({
    runAgent,
    haltForHuman,
    postTicketNote: async () => {},
    fetchTicketSnapshot: async () => answeredSnapshot,
    claim: {
      issueId: snapshot.id,
      identifier: snapshot.identifier,
      token: `linear:ticket:${snapshot.id}`,
      hook: {} as TicketClaim["hook"],
    },
    snapshot,
    harness: harnesses.codex("gpt-5.5"),
    cwd: "/tmp",
  });

  expect(halts).toHaveLength(1);
  expect(handoff.snapshot).toBe(answeredSnapshot);
});
