import { beforeEach, expect, test } from "vitest";
import { claude } from "../agent/harness-config.ts";
import { type AgentStepConfig, parseOutput } from "../agent/plan.ts";
import type { AgentFn } from "../agent/resume-or-rebuild.ts";
import { promptRef } from "../agent/testing.ts";
import type { TicketClaim } from "../ticket/claim.ts";
import type {
  Halt,
  HaltForHumanFn,
  HumanReply,
} from "../ticket/halt-for-human.ts";
import type { Handoff } from "../ticket/review.ts";
import type { TicketSnapshot } from "../ticket/snapshot.ts";
import {
  codeReviewVerdict,
  implementUntilCodeReviewApproves,
  replyReading,
} from "./implement.ts";

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

// Applies parseOutput exactly as the real agent() does, so the verdict schema
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
    agent: fakeAgent,
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
  expect(() =>
    codeReviewVerdict.parse({ verdict: "maybe", findings: [] }),
  ).toThrow();
  expect(() =>
    codeReviewVerdict.parse({ verdict: "approved", findings: [], score: 9 }),
  ).toThrow();
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

  const first = promptRef(agentCalls[0]);
  expect(first.name).toBe("implement");
  expect(first.data.TICKET).toContain("AGE-316");
  expect(first.data.BRIEF).toContain("SECRET-BRIEF-TEXT");
  expect(first.data.REVIEW).toBe("_(first pass)_");

  const second = promptRef(agentCalls[2]);
  expect(second.data.REVIEW).toBe("- src/loop.ts: the CI bound is off by one");
});

test("the reviewer is never shown the brief and judges against the ticket", async () => {
  verdicts = [approved];
  await run();

  const review = agentCalls[1];
  const ref = promptRef(review);
  expect(ref.name).toBe("code-review");
  expect(ref.data.TICKET).toContain("AGE-316");
  expect(ref.data.BASE_SHA).toBe("base-sha-1");
  // No slot for the brief at all, so nothing can leak it into the reviewer.
  expect(Object.keys(ref.data).sort()).toEqual(["BASE_SHA", "TICKET"]);
  expect(review?.output).toBe(codeReviewVerdict);
});

const reading = (over: Record<string, unknown> = {}) => ({
  action: "continue",
  instructions: "",
  about: "",
  questions: [],
  ...over,
});

test("a malformed reply reading fails the schema", () => {
  expect(() => replyReading.parse(reading())).not.toThrow();
  expect(() => replyReading.parse(reading({ action: "halt" }))).toThrow();
  expect(() => replyReading.parse(reading({ extra: 1 }))).toThrow();
});

test("the cycle bound halts needs-human with the findings as notes and one open question", async () => {
  verdicts = [
    changes("one"),
    changes("two"),
    changes("three"),
    reading({ instructions: "drop finding three and ship the rest" }),
    approved,
  ];
  const result = await run();

  expect(humanCalls).toEqual([
    {
      headline:
        "jigs paused work on **AGE-316**. The builder and the reviewer could not agree after 3 rounds, and jigs needs you to decide how to proceed.",
      notes: ["three"],
      questions: [{ question: "How should the builder proceed?" }],
      onReply: "continue",
    },
  ]);
  // Three bounded cycles, one reading of the reply, then the round the
  // reading started. The halt is a pause, not a terminal state.
  expect(agentCalls).toHaveLength(9);
  expect(result.cycles).toBe(4);
});

test("the reply is read by an agent and never pasted into the builder's prompt", async () => {
  humanReply = "the reviewer is wrong, ship it";
  verdicts = [
    changes("one"),
    changes("two"),
    changes("three"),
    reading({
      instructions: "Ignore finding three. Land the change as it is.",
    }),
    approved,
  ];
  await run();

  const read = promptRef(agentCalls[6]);
  expect(read.name).toBe("read-reply");
  expect(read.data.REPLY).toBe("the reviewer is wrong, ship it");
  expect(read.data.FINDINGS).toBe("- three");
  expect(read.data.TICKET).toContain("AGE-316");
  expect(agentCalls[6]?.cwd).toBe("/tmp/worktree");
  expect(agentCalls[6]?.output).toBe(replyReading);

  // The builder gets what the reading produced, not the human's words.
  const next = promptRef(agentCalls[7]);
  expect(next.data.REVIEW).toBe(
    "Ignore finding three. Land the change as it is.",
  );
  expect(next.data.REVIEW).not.toContain("the reviewer is wrong");
});

test("a half-answered reply asks again on the ticket rather than guessing", async () => {
  verdicts = [
    changes("one"),
    changes("two"),
    changes("three"),
    reading({
      action: "ask",
      about: "You settled the first point. The second is still open.",
      questions: [{ question: "Should the builder keep the retry?" }],
    }),
    reading({ instructions: "keep the retry, drop the rest" }),
    approved,
  ];
  const result = await run();

  expect(humanCalls).toHaveLength(2);
  expect(humanCalls[1]).toEqual({
    headline:
      "jigs paused work on **AGE-316** again and needs one more answer before the builder continues.",
    about: "You settled the first point. The second is still open.",
    questions: [{ question: "Should the builder keep the retry?" }],
    onReply: "continue",
  });
  // Uncapped: the second answer is read the same way the first was.
  expect(promptRef(agentCalls[7]).name).toBe("read-reply");
  expect(promptRef(agentCalls[8]).data.REVIEW).toBe(
    "keep the retry, drop the rest",
  );
  expect(result.cycles).toBe(4);
});

test("the builder's session pointer is the one carried out, not the reviewer's", async () => {
  verdicts = [changes("one"), approved];
  const result = await run();
  // s-1 and s-3 are the implement steps; the reviewer declares an output
  // schema and this fake records no session for it.
  expect(result.session).toEqual({ harness: "claude", id: "s-3" });
});
