import { beforeEach, expect, test, vi } from "vitest";
import { harnesses } from "../agents/harness-config.ts";
import { parseOutput, type RunAgentOptions } from "../agents/plan.ts";
import type { RunAgentFn } from "../agents/resume-or-rebuild.ts";
import type { TicketClaim } from "./claim.ts";
import type { Halt, HaltForHumanFn, HumanReply } from "./halt-for-human.ts";
import {
  type PostTicketNote,
  reviewTicket,
  type TicketNote,
  ticketReviewVerdictSchema,
} from "./review.ts";
import type { TicketSnapshot } from "./snapshot.ts";
import type { TicketReviewPrompt } from "./ticket-review.prompt.ts";

const claim = {
  issueId: "68bc9696-35d5-442d-ab56-214c8cfefbec",
  identifier: "AGE-313",
  token: "linear:ticket:68bc9696-35d5-442d-ab56-214c8cfefbec",
  postedCommentIds: [] as string[],
} as TicketClaim;

const snapshot: TicketSnapshot = {
  fetchedAt: "2026-08-26T13:00:00Z",
  id: claim.issueId,
  identifier: "AGE-313",
  title: "Ticket snapshot and the reviewTicket jig",
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

let agentCalls: RunAgentOptions<unknown>[] = [];
let verdicts: unknown[] = [];
let humanCalls: Array<{ claim: TicketClaim; halt: Halt }> = [];
let noteCalls: Array<{ issueId: string } & TicketNote> = [];
let fetched: string[] = [];

const reply: HumanReply = {
  commentId: "c9",
  body: "cap comments at 100",
  author: { id: "u1", name: "salim" },
  createdAt: "2026-08-26T14:00:00Z",
};

// Applies parseOutput exactly as the real runAgent() does, so the verdict schema
// is exercised through the production path rather than around it.
const fakeAgent: RunAgentFn = async <T>(config: RunAgentOptions<T>) => {
  agentCalls.push(config as RunAgentOptions<unknown>);
  return {
    text: "",
    output: parseOutput(config.output, verdicts.shift()),
  };
};

const fakeHaltForHuman: HaltForHumanFn = async (humanClaim, halt) => {
  humanCalls.push({ claim: humanClaim, halt });
  return reply;
};

const fakePostTicketNote: PostTicketNote = async (issueId, note) => {
  noteCalls.push({ issueId, ...note });
  return { commentId: `note-${noteCalls.length}` };
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
  reviewTicket({
    runAgent: fakeAgent,
    haltForHuman: fakeHaltForHuman,
    postTicketNote: fakePostTicketNote,
    fetchTicketSnapshot: fakeFetchSnapshot,
    claim,
    snapshot,
    harness: harnesses.claude("sonnet"),
    cwd: "/tmp/worktree",
  });

beforeEach(() => {
  agentCalls = [];
  humanCalls = [];
  noteCalls = [];
  claim.postedCommentIds = [];
  verdicts = [];
  fetched = [];
});

test("a malformed verdict object fails the schema", () => {
  const good = {
    verdict: "proceed",
    brief: "x",
    about: "a",
    questions: [],
    assumptions: [],
  };
  expect(() => ticketReviewVerdictSchema.parse(good)).not.toThrow();
  expect(() => ticketReviewVerdictSchema.parse({ ...good, verdict: "maybe" })).toThrow();
  expect(() => ticketReviewVerdictSchema.parse({ ...good, brief: "" })).toThrow();
  expect(() => ticketReviewVerdictSchema.parse({ ...good, confidence: 0.8 })).toThrow();
  // A question is a question and up to three plain choices — nothing else.
  expect(() =>
    ticketReviewVerdictSchema.parse({
      ...good,
      questions: [{ question: "which?", options: [{ label: "a", why: "no" }] }],
    }),
  ).toThrow();
});

const proceed = (over: Record<string, unknown> = {}) => ({
  verdict: "proceed",
  brief: "plan",
  about: "what the ticket is about",
  questions: [],
  assumptions: [],
  ...over,
});

const needsHuman = (over: Record<string, unknown> = {}) => ({
  verdict: "needs-human",
  brief: "draft",
  about: "what the ticket is about",
  questions: [{ question: "which one?" }],
  assumptions: [],
  ...over,
});

test("reviewTicket rejects when the agent returns a verdict the schema refuses", async () => {
  verdicts = [proceed({ verdict: "probably" })];
  await expect(review()).rejects.toThrow();
  expect(humanCalls).toHaveLength(0);
});

test("a proceed verdict returns the brief with the snapshot it was reviewed against", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  verdicts = [proceed({ brief: "Implement the snapshot fetch, then the jig." })];
  const result = await review();
  expect(result.brief).toBe("Implement the snapshot fetch, then the jig.");
  expect(result.snapshot).toBe(snapshot);
  expect(humanCalls).toHaveLength(0);
  expect(fetched).toEqual([]);
  expect(log).toHaveBeenCalledWith(
    "[reviewTicket] AGE-313 verdict=proceed questions=0 assumptions=0",
  );
});

test("a proceed verdict with assumptions posts them as a note that blocks nothing", async () => {
  verdicts = [proceed({ assumptions: ["Only the validate script changes."] })];
  const result = await review();

  expect(noteCalls).toHaveLength(1);
  expect(noteCalls[0]?.issueId).toBe(snapshot.id);
  expect(noteCalls[0]?.headline).toContain("AGE-313");
  expect(noteCalls[0]?.notes).toEqual(["Only the validate script changes."]);
  // Recorded, so a later halt in this run does not read the note as a reply.
  expect(claim.postedCommentIds).toEqual(["note-1"]);
  // Posted, not suspended on: the handoff comes straight back.
  expect(humanCalls).toHaveLength(0);
  expect(result.assumptions).toEqual(["Only the validate script changes."]);
});

test("a proceed verdict with nothing assumed posts no note at all", async () => {
  verdicts = [proceed()];
  await review();
  expect(noteCalls).toEqual([]);
});

test("a needs-human verdict routes the questions and the about to haltForHuman, never the brief", async () => {
  verdicts = [
    needsHuman({
      brief: "SECRET-BRIEF-TEXT that must not reach Linear",
      about: "The tests leave files nobody can delete.",
      questions: [
        {
          question: "Which of the two fixes should we use?",
          context: "The ticket offers two, but they behave differently.",
          options: [
            { label: "Run as whoever launched the tests.", recommended: true },
            { label: "Build one fixed user into the image." },
          ],
        },
      ],
    }),
    proceed(),
  ];
  await review();

  expect(humanCalls).toHaveLength(1);
  const call = humanCalls[0];
  expect(call?.claim).toBe(claim);
  expect(call?.halt).toEqual({
    headline: "jigs paused work on **AGE-313** and needs your answers before it writes any code.",
    where: "ticket review",
    about: "The tests leave files nobody can delete.",
    questions: [
      {
        question: "Which of the two fixes should we use?",
        context: "The ticket offers two, but they behave differently.",
        options: [
          { label: "Run as whoever launched the tests.", recommended: true },
          { label: "Build one fixed user into the image." },
        ],
      },
    ],
    onReply: "continue",
  });
  expect(JSON.stringify(call?.halt)).not.toContain("SECRET-BRIEF-TEXT");
});

test("a needs-human verdict with nothing to say about the ticket carries no about", async () => {
  verdicts = [needsHuman({ about: "" }), proceed()];
  await review();
  expect(humanCalls[0]?.halt.about).toBeUndefined();
});

test("optional callbacks run around the human halt, never around proceed", async () => {
  const events: string[] = [];
  verdicts = [needsHuman(), proceed()];
  await reviewTicket({
    runAgent: fakeAgent,
    haltForHuman: async (humanClaim, halt) => {
      events.push("halt");
      return fakeHaltForHuman(humanClaim, halt);
    },
    postTicketNote: fakePostTicketNote,
    fetchTicketSnapshot: async (issueId) => {
      events.push("refresh");
      return fakeFetchSnapshot(issueId);
    },
    claim,
    snapshot,
    harness: harnesses.claude("sonnet"),
    cwd: "/tmp/worktree",
    on: {
      needsHuman: async () => {
        events.push("needs-human");
      },
      humanReplied: async () => {
        events.push("human-replied");
      },
    },
  });
  expect(events).toEqual(["needs-human", "halt", "human-replied", "refresh"]);

  events.length = 0;
  verdicts = [proceed()];
  await reviewTicket({
    runAgent: fakeAgent,
    haltForHuman: fakeHaltForHuman,
    postTicketNote: fakePostTicketNote,
    fetchTicketSnapshot: fakeFetchSnapshot,
    claim,
    snapshot,
    harness: harnesses.claude("sonnet"),
    cwd: "/tmp/worktree",
    on: {
      needsHuman: async () => {
        events.push("needs-human");
      },
      humanReplied: async () => {
        events.push("human-replied");
      },
    },
  });
  expect(events).toEqual([]);
});

test("the needs-human round re-reads the ticket, so the human's reply is what the next review sees", async () => {
  verdicts = [needsHuman(), needsHuman(), proceed({ brief: "the agreed plan" })];
  const result = await review();

  // Three reviews, two halts, one re-read per halt: the halt is a pause, and
  // the loop is inside this block rather than in every workflow that calls it.
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
  verdicts = [proceed()];
  await review();
  const prompt = agentCalls[0]?.prompt ?? "";
  expect(prompt).toContain("restate, not re-decide");
  expect(prompt).toContain("AGE-313");
  expect(prompt).toContain("Fetch the ticket on each activation.");
  expect(prompt).not.toContain("{{TICKET}}");
});

test("a caller-supplied prompt replaces the one shipped beside the block", async () => {
  verdicts = [proceed()];
  const factoryPrompt: TicketReviewPrompt = ({ ticket }) => `# Infra ticket review\n\n${ticket}`;
  await reviewTicket({
    runAgent: fakeAgent,
    haltForHuman: fakeHaltForHuman,
    postTicketNote: fakePostTicketNote,
    fetchTicketSnapshot: fakeFetchSnapshot,
    claim,
    snapshot,
    harness: harnesses.claude("sonnet"),
    cwd: "/tmp/worktree",
    prompt: factoryPrompt,
  });

  const prompt = agentCalls[0]?.prompt ?? "";
  expect(prompt).toContain("# Infra ticket review");
  expect(prompt).toContain("AGE-313");
  expect(prompt).not.toContain("restate, not re-decide");
});

test("the verdict schema is declared on the agent step so the harness emits it natively", async () => {
  verdicts = [proceed()];
  await review();
  expect(agentCalls[0]?.output).toBe(ticketReviewVerdictSchema);
  expect(agentCalls[0]?.cwd).toBe("/tmp/worktree");
});
