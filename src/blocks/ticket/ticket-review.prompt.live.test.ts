import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type ExecuteDeps, realDeps } from "../../steps/agent/execute-agent.ts";
import { executeModelRequest } from "../../steps/agent/execute-model-request.ts";
import { ensureManagedCodexHome } from "../../steps/agent/harnesses/codex-home.ts";
import { stripApiCredentials } from "../../steps/agent/harnesses/env.ts";
import { assertLivePreconditions } from "../../steps/agent/harnesses/live/fixtures/live-env.ts";
import { makeTmpDir, removeTmpDir } from "../../steps/agent/harnesses/test-fixtures.ts";
import { codex } from "../agent/harness-config.ts";
import { type AgentStepConfig, buildAskWire, parseOutput } from "../agent/plan.ts";
import type { AgentFn } from "../agent/resume-or-rebuild.ts";
import type { TicketClaim } from "./claim.ts";
import type { HaltForHumanFn, HumanReply } from "./halt-for-human.ts";
import { reviewTicket } from "./review.ts";
import type { TicketSnapshot } from "./snapshot.ts";

let tmp: string;
let deps: ExecuteDeps;

beforeAll(() => {
  assertLivePreconditions();
  stripApiCredentials();
  tmp = makeTmpDir();
  deps = {
    ...realDeps,
    ensureCodexHome: (runId) =>
      ensureManagedCodexHome(runId, { baseDir: path.join(tmp, "codex-homes") }),
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
  const runAgent: AgentFn = async <T>(config: AgentStepConfig<T>) => {
    const result = await executeModelRequest(
      buildAskWire({
        harness: config.harness,
        prompt: config.prompt,
        ...(config.output === undefined ? {} : { output: config.output }),
      }),
      { workflowRunId: runId },
      deps,
    );
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
    harness: codex({ model: "gpt-5.5" }),
    cwd: "/tmp",
  });

  expect(halts).toHaveLength(1);
  expect(handoff.snapshot).toBe(answeredSnapshot);
});
