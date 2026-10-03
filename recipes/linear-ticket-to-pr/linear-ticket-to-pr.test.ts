import {
  type Delivery,
  harnesses,
  type NeedsHuman,
  type TicketClaim,
  type TicketHandoff,
  type TicketSnapshot,
} from "@jigs-ai/jigs";
import { beforeEach, expect, test, vi } from "vitest";
import * as routines from "#jigs/routines";
import * as steps from "#jigs/steps";
import entry, { linearTicketToPr } from "./linear-ticket-to-pr.ts";
import { prompts, type Ticket } from "./prompts.ts";

// The workflow body against mocked delivery routines: what it hands them, the
// ticket status it sets around each one, and the notes it words.
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
  postPullRequestNote: vi.fn(async () => {}),
  buildAndReview: vi.fn(async () => ({ reviewedCommit: "h1", notes: [], ledger: [] })),
  publishPullRequest: vi.fn(async () => pr),
  followPullRequestToOutcome: vi.fn(async () => "merged" as const),
}));

const pr = { owner: "acme", repo: "app", number: 7, url: "https://github.com/acme/app/pull/7" };
const worktree = {
  binding: "app",
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
const handed = () =>
  vi.mocked(routines.buildAndReview).mock.calls[0]?.[0] as Delivery<Ticket> | undefined;
const posted = () => vi.mocked(routines.noteOnTicket).mock.calls.map(([, note]) => note);
const following = () => vi.mocked(routines.followPullRequestToOutcome).mock.calls[0]?.[2];

beforeEach(() => vi.clearAllMocks());

test("a delivered ticket moves through In Progress, In Review and Done", async () => {
  await expect(run()).resolves.toEqual({ pr: pr.url });

  expect(routines.acquireTicket).toHaveBeenCalledWith("ABC-123");
  expect(statuses()).toEqual(["In Progress", "In Review", "Done"]);
  expect(vi.mocked(steps.setTicketStatus).mock.invocationCallOrder[1]).toBeGreaterThan(
    vi.mocked(routines.publishPullRequest).mock.invocationCallOrder[0] ?? Infinity,
  );
  expect(handed()).toMatchObject({ key: "ABC-123", worktree, prompts });
  expect(handed()?.work).toMatchObject({ key: "ABC-123", url: snapshot.url });
  expect(handed()?.work.instructions).toContain("## Implementation brief\nUse the flag.");
  expect(routines.buildAndReview).toHaveBeenCalledWith(expect.anything(), { rounds: 3 });
  expect(routines.publishPullRequest).toHaveBeenCalledWith(handed(), {
    commit: "h1",
    pullRequest: expect.any(Function),
  });
  expect(following()).toMatchObject({
    attemptsPerUpdate: 3,
    mergedBy: "human",
    approvalCovers: "latest-commit",
  });
});

test("a run picks its builder and reviewer by name, each in its own session", async () => {
  await run();
  expect(handed()?.builder.harness).toBe(entry.requires?.agents?.builder);
  expect(handed()?.reviewer.harness).toBe(entry.requires?.agents?.reviewer);
  expect(handed()?.builder).not.toBe(handed()?.reviewer);

  vi.clearAllMocks();
  await run({ builder: "reviewer", reviewer: "builder" });
  expect(handed()?.builder.harness).toBe(entry.requires?.agents?.reviewer);
  expect(handed()?.reviewer.harness).toBe(entry.requires?.agents?.builder);
  expect(
    entry.inputs.safeParse({ ticket: "ABC-123", binding: "app", builder: "opus" }).success,
  ).toBe(false);
});

test("the chosen reviewer also reviews the requirements", async () => {
  await run({ reviewer: "builder" });
  expect(routines.reviewTicket).toHaveBeenCalledWith(
    expect.objectContaining({ harness: entry.requires?.agents?.builder }),
  );
});

test("a run needs a binding before it claims the ticket", () => {
  expect(entry.inputs.safeParse({ ticket: "ABC-123", binding: "" }).success).toBe(false);
});

test("the reviewer's notes are appended to the pull request body", async () => {
  vi.mocked(routines.buildAndReview).mockResolvedValueOnce({
    reviewedCommit: "h1",
    notes: ["Rename x"],
    ledger: [],
  });
  await run();
  const shape = vi.mocked(routines.publishPullRequest).mock.calls[0]?.[1].pullRequest;
  expect(shape?.({ title: "Add a flag", body: "Adds it." })).toEqual({
    title: "Add a flag",
    body: "Adds it.\n\n## Reviewer notes\n\n- Rename x",
  });
});

test("a pull request that needs a person gets a note on the ticket and stays In Review", async () => {
  const facts: NeedsHuman = {
    reason: "builder-asked",
    detail: "Please inspect the conflict.",
  };
  vi.mocked(routines.followPullRequestToOutcome).mockImplementationOnce(
    async (_delivery, _pr, options) => {
      await options.onNeedsHuman(facts);
      return "merged";
    },
  );

  await expect(run()).resolves.toEqual({ pr: pr.url });

  expect(posted()).toEqual([
    {
      headline: "jigs needs a person to move the pull request for ABC-123 forward.",
      notes: [
        "The builder needs a person: Please inspect the conflict.",
        `Pull request: ${pr.url}`,
        "The work is on branch `acme/abc-123`, in the run's local worktree, which `jigs status` lists.",
      ],
      closing:
        "jigs is still watching the pull request: the next change to it, such as a re-run check, a new comment or review, or an approval, picks the work back up.",
    },
  ]);
  expect(statuses()).toEqual(["In Progress", "In Review", "Done"]);
});

test("needs-human notes say what holds back the merge and how many attempts ran out", async () => {
  vi.mocked(routines.followPullRequestToOutcome).mockImplementationOnce(
    async (_delivery, _pr, options) => {
      await options.onNeedsHuman({
        reason: "attempts-exhausted",
        detail: "Pushed.",
        unpublished: { dirty: true, localHead: "h2", pullRequestHead: "h1" },
      });
      await options.onNeedsHuman({
        reason: "merge-refused",
        detail: "merge method disabled",
        tries: 1,
      });
      await options.onNeedsHuman({ reason: "merge-refused", detail: "GitHub 502", tries: 10 });
      return "merged";
    },
  );

  await run();

  expect(posted().map((note) => note.notes.slice(0, 3))).toEqual([
    [
      "Exhausted 3 attempts for this pull request update.",
      expect.stringMatching(/dirty.*local HEAD is h2.*head is h1.*holds back the merge/),
      "The builder last said: Pushed.",
    ],
    [
      "Could not merge the pull request: merge method disabled",
      `Pull request: ${pr.url}`,
      expect.any(String),
    ],
    [
      "Could not merge the pull request after 10 tries: GitHub 502",
      `Pull request: ${pr.url}`,
      expect.any(String),
    ],
  ]);
});

test("a blocked merge is noted on the pull request with the delivery's scope", async () => {
  vi.mocked(routines.followPullRequestToOutcome).mockImplementationOnce(
    async (_delivery, _pr, options) => {
      await options.onMergeBlocked?.({
        headSha: "h1",
        scope: "linearTicketToPr/ABC-123",
        detail: "GitHub blocks the merge.",
      });
      return "merged";
    },
  );

  await run();

  expect(routines.postPullRequestNote).toHaveBeenCalledWith({
    pr,
    scope: "linearTicketToPr/ABC-123",
    headSha: "h1",
    reason: "merge-retry",
    body: "GitHub blocks the merge.",
  });
});

test("a stopped build posts its note on the ticket, sets Todo, and fails the run", async () => {
  vi.mocked(routines.buildAndReview).mockResolvedValueOnce({
    stopped: { reason: "rounds-exhausted", findings: ["Broken"], pushed: false },
  });

  await expect(run()).rejects.toThrow(
    "jigs stopped work on ABC-123 after 3 review round(s) without an approved change.",
  );

  expect(posted()).toEqual([
    {
      headline: "jigs stopped work on ABC-123 after 3 review round(s) without an approved change.",
      notes: [
        "Broken",
        "Could not push the branch; the service log has the push error.",
        "The work is on branch `acme/abc-123`, in the run's local worktree, which `jigs status` lists.",
      ],
      closing: expect.stringContaining("Another run starts over on a new branch"),
    },
  ]);
  expect(routines.publishPullRequest).not.toHaveBeenCalled();
  expect(statuses()).toEqual(["In Progress", "Todo"]);
});

test("a pull request closed without merging gets a note on the ticket, sets Todo, and fails the run", async () => {
  vi.mocked(routines.followPullRequestToOutcome).mockResolvedValueOnce("closed");

  await expect(run()).rejects.toThrow("jigs stopped pull request maintenance for ABC-123.");

  expect(posted()[0]).toMatchObject({
    headline: "jigs stopped pull request maintenance for ABC-123.",
    notes: expect.arrayContaining([
      "The pull request was closed unmerged.",
      `Unfinished pull request: ${pr.url}`,
    ]),
  });
  expect(statuses()).toEqual(["In Progress", "In Review", "Todo"]);
});

test("any other failure leaves the ticket alone", async () => {
  vi.mocked(routines.buildAndReview).mockRejectedValueOnce(new Error("boom"));

  await expect(run()).rejects.toThrow("boom");

  expect(routines.noteOnTicket).not.toHaveBeenCalled();
  expect(statuses()).toEqual(["In Progress"]);
});

test("the reviewer is told no pull request or CI exists yet and to stay off GitHub", () => {
  const work = { key: "ABC-123", title: "Ship it", url: snapshot.url, instructions: "Do it." };
  const prompt = prompts.review.fresh({ work, worktree, headSha: "h1", diff: "", ledger: [] });
  const resumed = prompts.review.resume({ headSha: "h1", diff: "", responses: [] });
  for (const text of [prompt, resumed]) {
    expect(text).toContain("No pull request exists yet and CI has not run");
    expect(text).toContain("do not look up pull requests, branches or CI status on GitHub");
  }
});

test("the maintenance prompt says when to wait, when to ask for a person, and what wakes the builder", () => {
  const prompt = prompts.maintain.resume({
    pr,
    snapshot: {} as Parameters<typeof prompts.maintain.resume>[0]["snapshot"],
  });
  expect(prompt).toContain("https://github.com/acme/app/pull/7");
  expect(prompt).toContain("A check that failed for a reason you cannot see");
  expect(prompt).toContain("You are woken again on the next change to the pull request");
  expect(prompt).toContain("Checks that queue, run or pass do not wake you");
});

test("the workflow requires its two agents, Linear and GitHub, and the builder acts as the App", () => {
  expect(entry.requires).toEqual({
    agents: {
      builder: harnesses.codex({ model: "gpt-5.6-sol", github: true }),
      reviewer: harnesses.claude({ model: "opus" }),
    },
    integrations: ["linear", "github"],
  });
  expect(entry.inputs.safeParse({ ticket: "", binding: "app" }).success).toBe(false);
});

test("attempts per update must be positive", () => {
  expect(
    entry.inputs.safeParse({ ticket: "ABC-123", binding: "app", budget: { attemptsPerUpdate: 0 } })
      .success,
  ).toBe(false);
});
