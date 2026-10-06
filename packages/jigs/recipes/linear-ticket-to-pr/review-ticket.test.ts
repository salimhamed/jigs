import {
  type Halt,
  type HumanReply,
  harnesses,
  type RunAgentOptions,
  type TicketClaim,
  type TicketNote,
  type TicketSnapshot,
  ticketReviewVerdictSchema,
} from "@jigs-ai/jigs";
import { beforeEach, expect, test, vi } from "vitest";
import { reviewTicket } from "./review-ticket.ts";

const claim = {
  installationName: "linear-acme",
  issueId: "68bc9696-35d5-442d-ab56-214c8cfefbec",
  identifier: "AGE-313",
  token: "linear:ticket:linear-acme:68bc9696-35d5-442d-ab56-214c8cfefbec",
  postedCommentIds: [] as string[],
} as TicketClaim;

const snapshot: TicketSnapshot = {
  fetchedAt: "2026-08-26T13:00:00Z",
  id: claim.issueId,
  identifier: "AGE-313",
  title: "Ticket snapshot and review",
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

const reply: HumanReply = {
  commentId: "c9",
  body: "cap comments at 100",
  author: { id: "u1", name: "salim" },
  createdAt: "2026-08-26T14:00:00Z",
};

const fake = vi.hoisted(() => ({
  agentCalls: [] as RunAgentOptions<unknown>[],
  verdicts: [] as unknown[],
  humanCalls: [] as Array<{ claim: TicketClaim; halt: Halt }>,
  noteCalls: [] as Array<{ claim: TicketClaim; note: TicketNote }>,
  fetched: [] as string[],
}));

// Validates the verdict against its schema, as the real runAgent does.
vi.mock("#jigs/routines", () => ({
  runAgent: async (config: RunAgentOptions<unknown>) => {
    fake.agentCalls.push(config);
    const verdict = fake.verdicts.shift();
    return { text: "", output: config.output?.parse(verdict) };
  },
  haltForHuman: async (humanClaim: TicketClaim, halt: Halt) => {
    fake.humanCalls.push({ claim: humanClaim, halt });
    return reply;
  },
  noteOnTicket: async (noteClaim: TicketClaim, note: TicketNote) => {
    fake.noteCalls.push({ claim: noteClaim, note });
  },
}));

// The reply landed on the ticket, so each re-read carries one more comment.
vi.mock("#jigs/steps", () => ({
  fetchTicketSnapshot: async (request: { installationName: string; issueId: string }) => {
    fake.fetched.push(`${request.installationName}:${request.issueId}`);
    return {
      ...snapshot,
      description: `${snapshot.description}\n\nRound ${fake.fetched.length}: ${reply.body}`,
    };
  },
}));

const review = () =>
  reviewTicket({
    claim,
    snapshot,
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: "/tmp/worktree",
  });

beforeEach(() => {
  fake.agentCalls = [];
  fake.humanCalls = [];
  fake.noteCalls = [];
  fake.verdicts = [];
  fake.fetched = [];
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

test("a verdict the schema refuses fails the review", async () => {
  fake.verdicts = [proceed({ verdict: "probably" })];
  await expect(review()).rejects.toThrow();
  expect(fake.humanCalls).toHaveLength(0);
});

test("a proceed verdict returns the brief with the snapshot it was reviewed against", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  fake.verdicts = [proceed({ brief: "Implement the snapshot fetch." })];
  const result = await review();
  expect(result.brief).toBe("Implement the snapshot fetch.");
  expect(result.snapshot).toBe(snapshot);
  expect(fake.humanCalls).toHaveLength(0);
  expect(fake.fetched).toEqual([]);
  expect(log).toHaveBeenCalledWith(
    "[reviewTicket] AGE-313 verdict=proceed questions=0 assumptions=0",
  );
});

test("a proceed verdict with assumptions posts them as a note that blocks nothing", async () => {
  fake.verdicts = [proceed({ assumptions: ["Only the validate script changes."] })];
  const result = await review();

  expect(fake.noteCalls).toHaveLength(1);
  expect(fake.noteCalls[0]?.claim).toBe(claim);
  expect(fake.noteCalls[0]?.note.headline).toContain("AGE-313");
  expect(fake.noteCalls[0]?.note.notes).toEqual(["Only the validate script changes."]);
  expect(fake.humanCalls).toHaveLength(0);
  expect(result.assumptions).toEqual(["Only the validate script changes."]);
});

test("a proceed verdict with nothing assumed posts no note at all", async () => {
  fake.verdicts = [proceed()];
  await review();
  expect(fake.noteCalls).toEqual([]);
});

test("a needs-human verdict asks the questions and the about on the ticket, never the brief", async () => {
  fake.verdicts = [
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

  expect(fake.humanCalls).toHaveLength(1);
  const call = fake.humanCalls[0];
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
  fake.verdicts = [needsHuman({ about: "" }), proceed()];
  await review();
  expect(fake.humanCalls[0]?.halt.about).toBeUndefined();
});

test("each needs-human round re-reads the ticket, so the reply is what the next review sees", async () => {
  fake.verdicts = [needsHuman(), needsHuman(), proceed({ brief: "the agreed plan" })];
  const result = await review();

  expect(fake.agentCalls).toHaveLength(3);
  expect(fake.humanCalls).toHaveLength(2);
  expect(fake.fetched).toEqual([`linear-acme:${snapshot.id}`, `linear-acme:${snapshot.id}`]);
  expect(fake.agentCalls[0]?.prompt).not.toContain("cap comments at 100");
  expect(fake.agentCalls[1]?.prompt).toContain("Round 1: cap comments at 100");
  expect(fake.agentCalls[2]?.prompt).toContain("Round 2: cap comments at 100");
  expect(result.brief).toBe("the agreed plan");
  expect(result.snapshot.description).toContain("Round 2");
});

test("the prompt carries the rendered ticket and declares the verdict schema", async () => {
  fake.verdicts = [proceed()];
  await review();
  const call = fake.agentCalls[0];
  expect(call?.prompt).toContain("restate, not re-decide");
  expect(call?.prompt).toContain("Fetch the ticket on each activation.");
  expect(call?.output).toBe(ticketReviewVerdictSchema);
  expect(call?.cwd).toBe("/tmp/worktree");
});
