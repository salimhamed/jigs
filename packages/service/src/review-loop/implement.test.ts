import { type AgentStepConfig, claude } from "jigs/steps";
import { beforeEach, expect, test } from "vitest";
import { parseOutput } from "../steps";
import type { TicketClaim } from "../suspension/claim";
import type { HumanReply } from "../suspension/needs-human";
import type { JsonValue } from "../suspension/record";
import type { Handoff } from "../ticket/review";
import type { TicketSnapshot } from "../ticket/snapshot";
import {
  codeReviewVerdict,
  type ImplementDeps,
  implementAndReview,
} from "./implement";

const claim = {
  issueId: "68bc9696-35d5-442d-ab56-214c8cfefbec",
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

const handoff: Handoff = { brief: "SECRET-BRIEF-TEXT: build it", snapshot };

let agentCalls: AgentStepConfig<unknown>[] = [];
let verdicts: unknown[] = [];
let humanCalls: Array<{ reason: string; payload?: JsonValue }> = [];
let humanReply = "the reviewer is wrong, ship it";

// Applies parseOutput exactly as the real agent() does, so the verdict schema
// is exercised through the production path rather than around it.
const fakeAgent: ImplementDeps["agent"] = async <T>(
  config: AgentStepConfig<T>,
) => {
  agentCalls.push(config as AgentStepConfig<unknown>);
  const raw = config.output === undefined ? undefined : verdicts.shift();
  return {
    text: "",
    output: parseOutput(config.output, raw),
    files: [],
    usage: undefined,
    ...(config.output === undefined
      ? {
          session: { harness: "claude" as const, id: `s-${agentCalls.length}` },
        }
      : {}),
  };
};

const fakeNeedsHuman: ImplementDeps["needsHuman"] = async (
  _claim,
  reason,
  payload,
) => {
  humanCalls.push({ reason, payload });
  return {
    commentId: `c${humanCalls.length}`,
    body: humanReply,
    author: { id: "u1", name: "salim" },
    createdAt: "2026-08-26T14:00:00Z",
  } satisfies HumanReply;
};

const deps: ImplementDeps = { agent: fakeAgent, needsHuman: fakeNeedsHuman };

const run = (maxCycles?: number) =>
  implementAndReview(
    {
      claim,
      handoff,
      harness: claude({ model: "sonnet" }),
      cwd: "/tmp/worktree",
      baseSha: "base-sha-1",
      ...(maxCycles === undefined ? {} : { maxCycles }),
    },
    deps,
  );

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

  const first = agentCalls[0]?.prompt ?? "";
  expect(first).toContain("AGE-316");
  expect(first).toContain("SECRET-BRIEF-TEXT");
  expect(first).toContain("_(first pass)_");
  expect(first).not.toContain("{{REVIEW}}");
  expect(agentCalls[0]?.permissionMode).toBe("bypassPermissions");

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
  // The reviewer needs Bash to read the diff it judges against.
  expect(review?.permissionMode).toBe("bypassPermissions");
});

test("a caller-supplied reviewer prompt replaces the default and is interpolated", async () => {
  verdicts = [approved];
  await implementAndReview(
    {
      claim,
      handoff,
      harness: claude({ model: "sonnet" }),
      cwd: "/tmp/worktree",
      baseSha: "base-sha-1",
      reviewPrompt: "Custom review of {{TICKET}} at {{BASE_SHA}} — {{UNKNOWN}}",
    },
    deps,
  );

  const review = agentCalls[1]?.prompt ?? "";
  expect(review).toContain("Custom review of");
  expect(review).toContain("AGE-316");
  expect(review).toContain("base-sha-1");
  expect(review).toContain("{{UNKNOWN}}");
});

test("the cycle bound halts needs-human with the findings, and the human's reply drives the next round", async () => {
  verdicts = [changes("one"), changes("two"), changes("three"), approved];
  const result = await run(3);

  expect(humanCalls).toHaveLength(1);
  expect(humanCalls[0]?.reason).toContain("3-cycle bound");
  expect(humanCalls[0]?.payload).toEqual({ findings: ["three"] });
  // Four implement + review pairs: three bounded cycles, then the round the
  // human's reply started. The halt is a pause, not a terminal state.
  expect(agentCalls).toHaveLength(8);
  expect(agentCalls[6]?.prompt).toContain("the reviewer is wrong, ship it");
  expect(result.cycles).toBe(4);
});

test("the builder's session pointer is the one carried out, not the reviewer's", async () => {
  verdicts = [changes("one"), approved];
  const result = await run();
  // s-1 and s-3 are the implement steps; the reviewer declares an output
  // schema and this fake records no session for it.
  expect(result.session).toEqual({ harness: "claude", id: "s-3" });
});
