import { type AgentStepConfig, claude } from "jigs/steps";
import { beforeEach, expect, test, vi } from "vitest";
import { parseOutput } from "../steps";
import type { TicketClaim } from "../suspension/claim";
import type { HumanReply } from "../suspension/needs-human";
import type { JsonValue } from "../suspension/record";
import {
  type TicketReviewDeps,
  ticketReview,
  ticketReviewVerdict,
} from "./review";
import type { TicketSnapshot } from "./snapshot";

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
let agentRaw: unknown;
let humanCalls: Array<{
  claim: TicketClaim;
  reason: string;
  payload?: JsonValue;
}> = [];

const reply: HumanReply = {
  commentId: "c9",
  body: "cap comments at 100",
  author: { id: "u1", name: "salim" },
  createdAt: "2026-08-26T14:00:00Z",
};

// Applies parseOutput exactly as the real agent() does, so the verdict schema
// is exercised through the production path rather than around it.
const fakeAgent: TicketReviewDeps["agent"] = async <T>(
  config: AgentStepConfig<T>,
) => {
  agentCalls.push(config as AgentStepConfig<unknown>);
  return {
    text: "",
    output: parseOutput(config.output, agentRaw),
    files: [],
    usage: undefined,
  };
};

const fakeNeedsHuman: TicketReviewDeps["needsHuman"] = async (
  humanClaim,
  reason,
  payload,
) => {
  humanCalls.push({ claim: humanClaim, reason, payload });
  return reply;
};

const deps: TicketReviewDeps = { agent: fakeAgent, needsHuman: fakeNeedsHuman };

const review = () =>
  ticketReview(
    {
      claim,
      snapshot,
      harness: claude({ model: "sonnet" }),
      cwd: "/tmp/worktree",
    },
    deps,
  );

beforeEach(() => {
  agentCalls = [];
  humanCalls = [];
  agentRaw = undefined;
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
  agentRaw = { verdict: "probably", brief: "a plan of sorts", findings: [] };
  await expect(review()).rejects.toThrow();
  expect(humanCalls).toHaveLength(0);
});

test("a proceed verdict returns the brief with the snapshot it was reviewed against", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  agentRaw = {
    verdict: "proceed",
    brief: "Implement the snapshot fetch, then the jig.",
    findings: [],
  };
  const result = await review();
  expect(result.verdict).toBe("proceed");
  expect(result.brief).toBe("Implement the snapshot fetch, then the jig.");
  expect(result.snapshot).toBe(snapshot);
  expect(humanCalls).toHaveLength(0);
  expect(log).toHaveBeenCalledWith(
    "[ticketReview] AGE-313 verdict=proceed findings=0",
  );
});

test("a needs-human verdict routes the findings to needsHuman and never the brief", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  agentRaw = {
    verdict: "needs-human",
    brief: "SECRET-BRIEF-TEXT that must not reach Linear",
    findings: ["no acceptance criteria for the resume path"],
  };
  const result = await review();

  expect(humanCalls).toHaveLength(1);
  const call = humanCalls[0];
  expect(call?.claim).toBe(claim);
  expect(call?.payload).toEqual({
    findings: ["no acceptance criteria for the resume path"],
  });
  expect(JSON.stringify(call?.payload)).not.toContain("SECRET-BRIEF-TEXT");
  // One agent step, and nothing after the halt.
  expect(agentCalls).toHaveLength(1);
  expect(result.verdict).toBe("needs-human");
  expect(result.brief).toContain("SECRET-BRIEF-TEXT");
  expect(log).toHaveBeenCalledWith(
    "[ticketReview] AGE-313 verdict=needs-human findings=1",
  );
});

test("the prompt carries the rendered ticket", async () => {
  agentRaw = { verdict: "proceed", brief: "plan", findings: [] };
  await review();
  const prompt = agentCalls[0]?.prompt ?? "";
  expect(prompt).toContain("restate, not re-decide");
  expect(prompt).toContain("AGE-313");
  expect(prompt).toContain("Fetch the ticket on each activation.");
  expect(prompt).not.toContain("{{TICKET}}");
});

test("the verdict schema is declared on the agent step so the harness emits it natively", async () => {
  agentRaw = { verdict: "proceed", brief: "plan", findings: [] };
  await review();
  expect(agentCalls[0]?.output).toBe(ticketReviewVerdict);
  expect(agentCalls[0]?.cwd).toBe("/tmp/worktree");
});
