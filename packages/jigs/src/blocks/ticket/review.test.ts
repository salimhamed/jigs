import { beforeEach, expect, test, vi } from "vitest";
import { claude } from "../agent/harness-config.ts";
import { type AgentStepConfig, parseOutput } from "../agent/plan.ts";
import type { AgentFn } from "../agent/resume-or-rebuild.ts";
import type { TicketClaim } from "./claim.ts";
import type { HumanReply, JsonValue, NeedsHumanFn } from "./halt-for-human.ts";
import { ticketReview, ticketReviewVerdict } from "./review.ts";
import type { TicketSnapshot } from "./snapshot.ts";

const claim = {
  issueId: "68bc9696-35d5-442d-ab56-214c8cfefbec",
  token: "linear:ticket:68bc9696-35d5-442d-ab56-214c8cfefbec",
} as TicketClaim;

const snapshot: TicketSnapshot = {
  fetchedAt: "2026-08-26T13:00:00Z",
  id: claim.issueId,
  identifier: "AGE-313",
  title: "Ticket snapshot and the ticketReview jig",
  description: "## Scope\n\nFetch the ticket on each activation.",
  url: "https://linear.app/x/issue/AGE-313",
  branchName: "salimhamed/age-313-ticket-snapshot",
  state: "Todo",
  labels: ["ready-for-agent"],
  comments: [],
  blockedBy: [],
  blocks: [],
  links: [],
  subIssues: [],
};

let agentCalls: AgentStepConfig<unknown>[] = [];
let verdicts: unknown[] = [];
let humanCalls: Array<{
  claim: TicketClaim;
  reason: string;
  payload?: JsonValue;
}> = [];
let fetched: string[] = [];

const reply: HumanReply = {
  commentId: "c9",
  body: "cap comments at 100",
  author: { id: "u1", name: "salim" },
  createdAt: "2026-08-26T14:00:00Z",
};

// Applies parseOutput exactly as the real agent() does, so the verdict schema
// is exercised through the production path rather than around it.
const fakeAgent: AgentFn = async <T>(config: AgentStepConfig<T>) => {
  agentCalls.push(config as AgentStepConfig<unknown>);
  return {
    text: "",
    output: parseOutput(config.output, verdicts.shift()),
    usage: undefined,
  };
};

const fakeNeedsHuman: NeedsHumanFn = async (humanClaim, reason, payload) => {
  humanCalls.push({ claim: humanClaim, reason, payload });
  return reply;
};

// The reply landed on the ticket, so each re-read carries one more comment.
const fakeFetchSnapshot = async (issueId: string): Promise<TicketSnapshot> => {
  fetched.push(issueId);
  return {
    ...snapshot,
    description: `${snapshot.description}\n\nRound ${fetched.length}: ${reply.body}`,
  };
};

const review = () =>
  ticketReview({
    agent: fakeAgent,
    needsHuman: fakeNeedsHuman,
    fetchSnapshot: fakeFetchSnapshot,
    claim,
    snapshot,
    harness: claude({ model: "sonnet" }),
    cwd: "/tmp/worktree",
  });

beforeEach(() => {
  agentCalls = [];
  humanCalls = [];
  verdicts = [];
  fetched = [];
});

test("a malformed verdict object fails the schema", () => {
  expect(() =>
    ticketReviewVerdict.parse({ verdict: "maybe", brief: "x", findings: [] }),
  ).toThrow();
  expect(() =>
    ticketReviewVerdict.parse({ verdict: "proceed", brief: "", findings: [] }),
  ).toThrow();
  expect(() =>
    ticketReviewVerdict.parse({
      verdict: "proceed",
      brief: "x",
      findings: [],
      confidence: 0.8,
    }),
  ).toThrow();
});

test("ticketReview rejects when the agent returns a verdict the schema refuses", async () => {
  verdicts = [{ verdict: "probably", brief: "a plan of sorts", findings: [] }];
  await expect(review()).rejects.toThrow();
  expect(humanCalls).toHaveLength(0);
});

test("a proceed verdict returns the brief with the snapshot it was reviewed against", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  verdicts = [
    {
      verdict: "proceed",
      brief: "Implement the snapshot fetch, then the jig.",
      findings: [],
    },
  ];
  const result = await review();
  expect(result.brief).toBe("Implement the snapshot fetch, then the jig.");
  expect(result.snapshot).toBe(snapshot);
  expect(humanCalls).toHaveLength(0);
  expect(fetched).toEqual([]);
  expect(log).toHaveBeenCalledWith(
    "[ticketReview] AGE-313 verdict=proceed findings=0",
  );
});

test("a needs-human verdict routes the findings to needsHuman and never the brief", async () => {
  verdicts = [
    {
      verdict: "needs-human",
      brief: "SECRET-BRIEF-TEXT that must not reach Linear",
      findings: ["no acceptance criteria for the resume path"],
    },
    { verdict: "proceed", brief: "plan", findings: [] },
  ];
  await review();

  expect(humanCalls).toHaveLength(1);
  const call = humanCalls[0];
  expect(call?.claim).toBe(claim);
  expect(call?.payload).toEqual({
    findings: ["no acceptance criteria for the resume path"],
  });
  expect(JSON.stringify(call?.payload)).not.toContain("SECRET-BRIEF-TEXT");
});

test("the needs-human round re-reads the ticket, so the human's reply is what the next review sees", async () => {
  verdicts = [
    { verdict: "needs-human", brief: "draft", findings: ["thin"] },
    { verdict: "needs-human", brief: "draft", findings: ["still thin"] },
    { verdict: "proceed", brief: "the agreed plan", findings: [] },
  ];
  const result = await review();

  // Three reviews, two halts, one re-read per halt: the halt is a pause, and
  // the loop is inside this block rather than in every pipeline that calls it.
  expect(agentCalls).toHaveLength(3);
  expect(humanCalls).toHaveLength(2);
  expect(fetched).toEqual([snapshot.id, snapshot.id]);
  expect(agentCalls[0]?.prompt).not.toContain("cap comments at 100");
  expect(agentCalls[1]?.prompt).toContain("Round 1: cap comments at 100");
  expect(agentCalls[2]?.prompt).toContain("Round 2: cap comments at 100");
  expect(result.brief).toBe("the agreed plan");
  // The handoff carries the snapshot the proceeding round actually read.
  expect(result.snapshot.description).toContain("Round 2");
});

test("the prompt carries the rendered ticket", async () => {
  verdicts = [{ verdict: "proceed", brief: "plan", findings: [] }];
  await review();
  const prompt = agentCalls[0]?.prompt ?? "";
  expect(prompt).toContain("restate, not re-decide");
  expect(prompt).toContain("AGE-313");
  expect(prompt).toContain("Fetch the ticket on each activation.");
  expect(prompt).not.toContain("{{TICKET}}");
});

test("the verdict schema is declared on the agent step so the harness emits it natively", async () => {
  verdicts = [{ verdict: "proceed", brief: "plan", findings: [] }];
  await review();
  expect(agentCalls[0]?.output).toBe(ticketReviewVerdict);
  expect(agentCalls[0]?.cwd).toBe("/tmp/worktree");
});
