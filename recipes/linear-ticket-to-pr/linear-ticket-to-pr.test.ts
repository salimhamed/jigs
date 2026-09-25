import {
  harnesses,
  type TicketClaim,
  type TicketHandoff,
  type TicketSnapshot,
} from "@jigs-ai/jigs";
import { beforeEach, expect, test, vi } from "vitest";
import * as routines from "#jigs/routines";
import * as steps from "#jigs/steps";
import * as delivery from "./delivery/delivery.ts";
import entry, { linearTicketToPr } from "./linear-ticket-to-pr.ts";

// The workflow body against mocked phases: which agents it hands delivery, and
// the ticket status it sets around each phase.
vi.mock("./delivery/delivery.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./delivery/delivery.ts")>()),
  implementAndReview: vi.fn(async () => ({ reviewedCommit: "h1", ledger: [] })),
  publish: vi.fn(async () => pr),
  followPullRequest: vi.fn(async () => {}),
}));
vi.mock("#jigs/steps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#jigs/steps")>()),
  provisionWorktree: vi.fn(async () => worktree),
  setTicketStatus: vi.fn(async () => ({})),
}));
vi.mock("#jigs/routines", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#jigs/routines")>()),
  acquireTicket: vi.fn(async () => ({ claim, snapshot })),
  reviewTicket: vi.fn(async (): Promise<TicketHandoff> => handoff),
  noteOnTicket: vi.fn(async () => {}),
}));

const pr = { owner: "acme", repo: "app", number: 7, url: "https://github.com/acme/app/pull/7" };
const worktree = {
  path: "/tmp/wt",
  branch: "acme/abc-123",
  defaultBranch: "main",
  baseSha: "base",
};
const snapshot: TicketSnapshot = {
  fetchedAt: "2026-01-01T00:00:00.000Z",
  id: "11111111-1111-4111-8111-111111111111",
  identifier: "ABC-123",
  title: "Ship it",
  description: "Do the thing.",
  url: "https://linear.app/acme/issue/ABC-123",
  branchName: "acme/abc-123",
  state: "Todo",
  labels: [],
  comments: [],
  blockedBy: [],
  blocks: [],
  links: [],
  subIssues: [],
};
const claim = { issueId: snapshot.id, identifier: snapshot.identifier } as TicketClaim;
const handoff: TicketHandoff = { brief: "Use the flag.", snapshot, assumptions: [] };

const run = (inputs: Record<string, unknown> = {}) =>
  linearTicketToPr({
    ...entry.inputs.parse({ ticket: "ABC-123", binding: "app", ...inputs }),
    triggerId: "test",
  });
const statuses = () => vi.mocked(steps.setTicketStatus).mock.calls.map(([, status]) => status);
const handed = () => vi.mocked(delivery.implementAndReview).mock.calls[0]?.[0];

beforeEach(() => vi.clearAllMocks());

test("a delivered ticket moves through In Progress, In Review and Done", async () => {
  await expect(run()).resolves.toEqual({ pr: pr.url });

  expect(routines.acquireTicket).toHaveBeenCalledWith("ABC-123");
  expect(statuses()).toEqual(["In Progress", "In Review", "Done"]);
  expect(vi.mocked(steps.setTicketStatus).mock.invocationCallOrder[1]).toBeGreaterThan(
    vi.mocked(delivery.publish).mock.invocationCallOrder[0] ?? Infinity,
  );
  expect(handed()?.task).toMatchObject({ key: "ABC-123", url: snapshot.url });
  expect(handed()?.task.instructions).toContain("## Implementation brief\nUse the flag.");
  expect(handed()?.budget).toEqual({ reviewRounds: 3, prTurns: 6 });
});

test("a run picks its builder and reviewer by name", async () => {
  await run();
  expect(handed()).toMatchObject({
    builder: entry.requires?.agents?.builder,
    reviewer: entry.requires?.agents?.reviewer,
  });

  vi.clearAllMocks();
  await run({ builder: "reviewer", reviewer: "builder" });
  expect(handed()).toMatchObject({
    builder: entry.requires?.agents?.reviewer,
    reviewer: entry.requires?.agents?.builder,
  });
  expect(
    entry.inputs.safeParse({ ticket: "ABC-123", binding: "app", builder: "opus" }).success,
  ).toBe(false);
});

test("a stopped delivery posts its note on the ticket, sets Todo, and fails the run", async () => {
  const stop = new delivery.DeliveryStopped("jigs stopped work on ABC-123.", ["open"], worktree);
  vi.mocked(delivery.followPullRequest).mockRejectedValueOnce(stop);

  await expect(run()).rejects.toBe(stop);

  expect(routines.noteOnTicket).toHaveBeenCalledWith(claim, stop.note());
  expect(statuses()).toEqual(["In Progress", "In Review", "Todo"]);
});

test("any other failure leaves the ticket alone", async () => {
  vi.mocked(delivery.implementAndReview).mockRejectedValueOnce(new Error("boom"));

  await expect(run()).rejects.toThrow("boom");

  expect(routines.noteOnTicket).not.toHaveBeenCalled();
  expect(statuses()).toEqual(["In Progress"]);
});

test("the workflow requires its two agents, Linear and GitHub", () => {
  expect(entry.requires).toEqual({
    agents: {
      builder: harnesses.codex({ model: "gpt-5.6-sol" }),
      reviewer: harnesses.claude({ model: "opus" }),
    },
    integrations: ["linear", "github"],
  });
  expect(entry.inputs.safeParse({ ticket: "", binding: "app" }).success).toBe(false);
});
