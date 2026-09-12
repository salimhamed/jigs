import { beforeEach, expect, test } from "vitest";
import { claude } from "../agent/harness-config.ts";
import { type AgentStepConfig, parseOutput } from "../agent/plan.ts";
import type { AgentFn } from "../agent/resume-or-rebuild.ts";
import type { TicketClaim } from "../ticket/claim.ts";
import type { Halt, HaltForHumanFn, HumanReply } from "../ticket/halt-for-human.ts";
import type { Handoff } from "../ticket/review.ts";
import type { TicketSnapshot } from "../ticket/snapshot.ts";
import { codeReviewVerdict, implementUntilCodeReviewApproves } from "./implement.ts";

const claim = {
  issueId: "68bc9696-35d5-442d-ab56-214c8cfefbec",
  identifier: "AGE-316",
  token: "linear:ticket:68bc9696-35d5-442d-ab56-214c8cfefbec",
} as TicketClaim;

const snapshot: TicketSnapshot = {
  fetchedAt: "2026-08-26T13:00:00Z",
  id: claim.issueId,
  identifier: "AGE-316",
  title: "Review loop jig",
  description: "## Acceptance criteria\n\n- the builder answers in-thread",
  url: "https://linear.app/x/issue/AGE-316",
  branchName: "salimhamed/age-316-review-loop",
  state: "Todo",
  labels: [],
  comments: [],
  blockedBy: [],
  blocks: [],
  links: [],
  subIssues: [],
};

const handoff: Handoff = {
  brief: "SECRET-BRIEF-TEXT: build it",
  snapshot,
  assumptions: [],
};

let agentCalls: AgentStepConfig<unknown>[] = [];
let verdicts: unknown[] = [];
let humanCalls: Halt[] = [];
let humanReply = "the reviewer is wrong, ship it";

// Applies parseOutput exactly as the real runAgent() does, so the verdict schema
// is exercised through the production path rather than around it.
const fakeAgent: AgentFn = async <T>(config: AgentStepConfig<T>) => {
  agentCalls.push(config as AgentStepConfig<unknown>);
  const raw = config.output === undefined ? undefined : verdicts.shift();
  return {
    text: "",
    output: parseOutput(config.output, raw),
    usage: undefined,
    ...(config.output === undefined
      ? {
          session: { harness: "claude" as const, id: `s-${agentCalls.length}` },
        }
      : {}),
  };
};

const fakeHaltForHuman: HaltForHumanFn = async (_claim, halt) => {
  humanCalls.push(halt);
  return {
    commentId: `c${humanCalls.length}`,
    body: humanReply,
    author: { id: "u1", name: "salim" },
    createdAt: "2026-08-26T14:00:00Z",
  } satisfies HumanReply;
};

const run = () =>
  implementUntilCodeReviewApproves({
    runAgent: fakeAgent,
    haltForHuman: fakeHaltForHuman,
    claim,
    handoff,
    harness: claude({ model: "sonnet" }),
    cwd: "/tmp/worktree",
    baseSha: "base-sha-1",
  });

const approved = { verdict: "approved", findings: [] };
const changes = (finding: string) => ({
  verdict: "changes-requested",
  findings: [finding],
});

beforeEach(() => {
  agentCalls = [];
  verdicts = [];
  humanCalls = [];
  humanReply = "the reviewer is wrong, ship it";
});

test("a malformed verdict object fails the schema", () => {
  expect(() => codeReviewVerdict.parse({ verdict: "maybe", findings: [] })).toThrow();
  expect(() => codeReviewVerdict.parse({ verdict: "approved", findings: [], score: 9 })).toThrow();
});

test("an approved first cycle runs one implement and one review step", async () => {
  verdicts = [approved];
  const result = await run();

  expect(agentCalls).toHaveLength(2);
  expect(result.cycles).toBe(1);
  expect(result.session).toEqual({ harness: "claude", id: "s-1" });
  expect(humanCalls).toHaveLength(0);
});

test("the implement step carries the ticket, the brief and the review findings", async () => {
  verdicts = [changes("src/loop.ts: the CI bound is off by one"), approved];
  await run();

  const first = agentCalls[0]?.prompt ?? "";
  expect(first).toContain("AGE-316");
  expect(first).toContain("SECRET-BRIEF-TEXT");
  expect(first).toContain("_(first pass)_");
  expect(first).not.toContain("{{REVIEW}}");

  const second = agentCalls[2]?.prompt ?? "";
  expect(second).toContain("- src/loop.ts: the CI bound is off by one");
  expect(second).not.toContain("_(first pass)_");
});

test("the reviewer is never shown the brief and judges against the ticket", async () => {
  verdicts = [approved];
  await run();

  const review = agentCalls[1];
  expect(review?.prompt).toContain("AGE-316");
  expect(review?.prompt).toContain("base-sha-1");
  expect(review?.prompt).not.toContain("SECRET-BRIEF-TEXT");
  expect(review?.output).toBe(codeReviewVerdict);
});

test("the cycle bound halts needs-human with the findings as notes and one plain question", async () => {
  verdicts = [changes("one"), changes("two"), changes("three"), approved];
  const result = await run();

  expect(humanCalls).toEqual([
    {
      headline:
        "jigs paused work on **AGE-316**. The builder and the reviewer could not agree after 3 rounds, and jigs needs you to decide how to proceed.",
      where: "code review",
      notes: ["three"],
      questions: [
        {
          question: "How should the builder proceed?",
          context:
            "Reply with what the builder should change or do next. The builder will follow your words as written, so give it direction rather than a question.",
        },
      ],
      onReply: "continue",
    },
  ]);
  // Three bounded cycles, then the round the reply started. The halt is a
  // pause, not a terminal state.
  expect(agentCalls).toHaveLength(8);
  expect(result.cycles).toBe(4);
});

test("the human's reply is what the builder is told to do next", async () => {
  humanReply = "Ignore finding three. Land the change as it is.";
  verdicts = [changes("one"), changes("two"), changes("three"), approved];
  await run();

  const next = agentCalls[6]?.prompt ?? "";
  expect(next).toContain("Ignore finding three. Land the change as it is.");
  expect(next).not.toContain("- three");
});
