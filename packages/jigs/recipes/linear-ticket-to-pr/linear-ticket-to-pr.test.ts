import {
  builderWakeFacts,
  type Delivery,
  harnesses,
  type NeedsHuman,
  type PullRequestSnapshot,
  type TicketClaim,
  type TicketSnapshot,
} from "@jigs-ai/jigs";
import { beforeEach, expect, test, vi } from "vitest";
import * as routines from "#jigs/routines";
import * as steps from "#jigs/steps";
import entry, { linearTicketToPr } from "./linear-ticket-to-pr.ts";
import { prompts, type Ticket } from "./prompts.ts";
import type { TicketHandoff } from "./review-ticket.ts";
import * as review from "./review-ticket.ts";

// The workflow body against mocked delivery routines: what it hands them, the
// ticket status it sets around each one, and the notes it words.
// The real scope reads the run's workflow name, which only a running workflow has.
vi.mock("@jigs-ai/jigs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@jigs-ai/jigs")>()),
  defaultPullRequestScope: (subject: string) => `linearTicketToPr/${subject}`,
}));
vi.mock("#jigs/steps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#jigs/steps")>()),
  provisionWorktree: vi.fn(async () => worktree),
  pushBranch: vi.fn(async () => ({ created: false })),
  setLinearAgentSessionUrls: vi.fn(async () => {}),
  setTicketStatus: vi.fn(async () => ({})),
}));
vi.mock("./review-ticket.ts", () => ({
  reviewTicket: vi.fn(async (): Promise<TicketHandoff> => handoff),
}));
vi.mock("#jigs/routines", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#jigs/routines")>()),
  acquireTicket: vi.fn(async () => ({ claim, snapshot })),
  noteOnTicket: vi.fn(async () => {}),
  postPullRequestNote: vi.fn(async () => {}),
  buildAndReview: vi.fn(async () => ({
    outcome: "approved" as const,
    reviewedCommit: "h1",
    notes: [],
    ledger: [],
  })),
  describePullRequest: vi.fn(async () => ({ title: "feat: add a flag", body: "Adds it." })),
  publishPullRequest: vi.fn(async () => pr),
  followPullRequestToOutcome: vi.fn(async () => ({ outcome: "merged" as const })),
}));

const pr = {
  installationName: "github-acme",
  owner: "acme",
  repo: "app",
  number: 7,
  url: "https://github.com/acme/app/pull/7",
};
const worktree = {
  binding: "app",
  installationName: "github-acme",
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
const claim = {
  installationName: "linear-acme",
  issueId: snapshot.id,
  identifier: snapshot.identifier,
  sessionId: "session-1",
} as TicketClaim;
const handoff: TicketHandoff = { brief: "Use the flag.", snapshot, assumptions: [] };

const run = (inputs: Record<string, unknown> = {}) =>
  linearTicketToPr({
    ...entry.inputs.parse({
      ticket: "ABC-123",
      binding: "app",
      linearInstallation: "linear-acme",
      ...inputs,
    }),
    triggerId: "test",
  });
const statuses = () =>
  vi.mocked(steps.setTicketStatus).mock.calls.map(([request]) => {
    expect(request).toMatchObject({ installationName: "linear-acme", issueId: snapshot.id });
    return request.stateName;
  });
const handed = () =>
  vi.mocked(routines.buildAndReview).mock.calls[0]?.[0] as Delivery<Ticket> | undefined;
const opened = {
  headline: `Pull request ${pr.url} is open.`,
  notes: [],
  closing:
    "jigs merges it once it's approved and CI passes. Comment on the pull request to change anything, or close it to stop the run.",
  run: "waiting",
};
const merged = {
  headline: `Merged ${pr.url}.`,
  notes: [],
  closing: "",
  run: "succeeded",
};
const failed = {
  headline: "The run failed. The run's page has the error.",
  notes: [],
  closing: "",
  run: "failed",
};
const posted = () => vi.mocked(routines.noteOnTicket).mock.calls.map(([, note]) => note);
const following = () => vi.mocked(routines.followPullRequestToOutcome).mock.calls[0]?.[2];

beforeEach(() => vi.clearAllMocks());

test("a delivered ticket moves through In Progress, In Review and Done", async () => {
  await expect(run()).resolves.toEqual({ pr: pr.url });

  expect(routines.acquireTicket).toHaveBeenCalledWith({
    installationName: "linear-acme",
    reference: "ABC-123",
  });
  expect(statuses()).toEqual(["In Progress", "In Review", "Done"]);
  expect(vi.mocked(steps.setTicketStatus).mock.invocationCallOrder[1]).toBeGreaterThan(
    vi.mocked(routines.publishPullRequest).mock.invocationCallOrder[0] ?? Infinity,
  );
  expect(handed()).toMatchObject({ key: "ABC-123", worktree, prompts });
  expect(handed()?.work).toMatchObject({ key: "ABC-123", url: snapshot.url });
  expect(handed()?.work.instructions).toContain("## Implementation brief\nUse the flag.");
  expect(routines.buildAndReview).toHaveBeenCalledWith(expect.anything(), { rounds: 3 });
  expect(routines.describePullRequest).toHaveBeenCalledWith(handed(), {
    check: expect.any(Function),
  });
  expect(routines.publishPullRequest).toHaveBeenCalledWith(handed(), {
    commit: "h1",
    title: "feat: add a flag",
    body: "Adds it.",
  });
  expect(following()).toMatchObject({
    attemptsPerUpdate: 3,
    wake: builderWakeFacts,
    approvalCovers: "latest-commit",
  });
  expect(following()?.mergeWhen({} as PullRequestSnapshot)).toBe(true);
  expect(posted()).toEqual([opened, merged]);
  expect(vi.mocked(routines.noteOnTicket).mock.invocationCallOrder[1]).toBeGreaterThan(
    vi.mocked(steps.setTicketStatus).mock.invocationCallOrder[2] ?? Infinity,
  );
});

test("an opened pull request is linked from the ticket's session, then a note waits on people", async () => {
  await run();

  expect(steps.setLinearAgentSessionUrls).toHaveBeenCalledExactlyOnceWith({
    installationName: "linear-acme",
    sessionId: "session-1",
    urls: [{ label: "Pull request", url: pr.url }],
  });
  const linked = vi.mocked(steps.setLinearAgentSessionUrls).mock.invocationCallOrder[0] ?? 0;
  expect(linked).toBeGreaterThan(
    vi.mocked(routines.publishPullRequest).mock.invocationCallOrder[0] ?? Infinity,
  );
  expect(vi.mocked(routines.noteOnTicket).mock.invocationCallOrder[0]).toBeGreaterThan(linked);
});

test("a title that is not a conventional commit is sent back to the writer with the problem", async () => {
  await run();
  const check = vi.mocked(routines.describePullRequest).mock.calls[0]?.[1]?.check;
  expect(check?.({ title: "feat(cli)!: add a flag", body: "" })).toEqual([]);
  expect(check?.({ title: "Add a flag", body: "" })).toEqual([
    expect.stringContaining('The title "Add a flag" is not a conventional commit subject'),
  ]);
});

test("a second unconventional title stops the run before anything is pushed", async () => {
  vi.mocked(routines.describePullRequest).mockImplementationOnce(async (_delivery, options) => {
    options?.check?.({ title: "Add a flag", body: "Adds it." });
    options?.check?.({ title: "Adds a flag", body: "Adds it." });
    throw new Error("still has problems");
  });

  await expect(run()).rejects.toThrow(
    "jigs stopped before opening a pull request for ABC-123: its title is not a conventional commit.",
  );

  expect(posted()).toEqual([
    {
      headline:
        "jigs stopped before opening a pull request for ABC-123: its title is not a conventional commit.",
      notes: [
        "Proposed titles: Add a flag, then Adds a flag",
        "The work is on branch `acme/abc-123`, in the run's local worktree, which `jigs status` lists.",
      ],
      closing:
        "Nothing has been pushed and nothing is waiting on a reply here. Push the branch and open the pull request by hand, or start another run.",
      run: "failed",
    },
  ]);
  expect(steps.pushBranch).not.toHaveBeenCalled();
  expect(routines.publishPullRequest).not.toHaveBeenCalled();
  expect(statuses()).toEqual(["In Progress", "Todo"]);
});

test("any other describe failure ends the session with the error and fails the run", async () => {
  vi.mocked(routines.describePullRequest).mockRejectedValueOnce(new Error("writer crashed"));

  await expect(run()).rejects.toThrow("writer crashed");
  expect(posted()).toEqual([failed]);
});

test("the describe prompt asks for a conventional-commit title", () => {
  const work = { key: "ABC-123", title: "Ship it", url: snapshot.url, instructions: "Do it." };
  expect(prompts.describe({ work, worktree, diff: "" })).toContain(
    "The title must be a conventional commit subject",
  );
});

test("a run picks its builder and reviewer by name, each in its own session", async () => {
  // The builder acts on GitHub through the worktree's installation; the reviewer stays off it.
  const actingAsApp = { github: { installationName: "github-acme" } };
  await run();
  expect(handed()?.builder.harness).toEqual({ ...entry.requires?.agents?.builder, ...actingAsApp });
  expect(handed()?.reviewer.harness).toBe(entry.requires?.agents?.reviewer);
  expect(handed()?.builder).not.toBe(handed()?.reviewer);

  vi.clearAllMocks();
  await run({ builder: "reviewer", reviewer: "builder" });
  expect(handed()?.builder.harness).toEqual({
    ...entry.requires?.agents?.reviewer,
    ...actingAsApp,
  });
  expect(handed()?.reviewer.harness).toBe(entry.requires?.agents?.builder);
  expect(
    entry.inputs.safeParse({
      ticket: "ABC-123",
      binding: "app",
      linearInstallation: "linear-acme",
      builder: "opus",
    }).success,
  ).toBe(false);
});

test("the chosen reviewer also reviews the requirements", async () => {
  await run({ reviewer: "builder" });
  expect(review.reviewTicket).toHaveBeenCalledWith(
    expect.objectContaining({ harness: entry.requires?.agents?.builder }),
  );
});

test("a run needs a binding and a Linear installation before it claims the ticket", () => {
  expect(
    entry.inputs.safeParse({ ticket: "ABC-123", binding: "", linearInstallation: "linear-acme" })
      .success,
  ).toBe(false);
  expect(entry.inputs.safeParse({ ticket: "ABC-123", binding: "app" }).success).toBe(false);
});

test("the reviewer's notes are appended to the pull request body", async () => {
  vi.mocked(routines.buildAndReview).mockResolvedValueOnce({
    outcome: "approved",
    reviewedCommit: "h1",
    notes: ["Rename x"],
    ledger: [],
  });
  await run();
  expect(vi.mocked(routines.publishPullRequest).mock.calls[0]?.[1]).toMatchObject({
    title: "feat: add a flag",
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
      return { outcome: "merged" };
    },
  );

  await expect(run()).resolves.toEqual({ pr: pr.url });

  expect(posted()).toEqual([
    opened,
    {
      headline: "jigs needs a person to move the pull request for ABC-123 forward.",
      notes: [
        "The builder needs a person: Please inspect the conflict.",
        `Pull request: ${pr.url}`,
        "The work is on branch `acme/abc-123`, in the run's local worktree, which `jigs status` lists.",
      ],
      closing:
        "Comment on the pull request or push to it, or close it to stop the run; replies here aren't read. jigs is still watching the pull request: the next change to it, such as a re-run check, a new comment or review, or an approval, picks the work back up.",
      run: "waiting",
    },
    merged,
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
      return { outcome: "merged" };
    },
  );

  await run();

  expect(posted().map((note) => note.notes.slice(0, 3))).toEqual([
    [],
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
    [],
  ]);
});

test("a blocked merge is noted on the pull request with the delivery's scope, not on the ticket", async () => {
  vi.mocked(routines.followPullRequestToOutcome).mockImplementationOnce(
    async (_delivery, _pr, options) => {
      await options.onNeedsHuman({
        reason: "merge-blocked",
        headSha: "h1",
        detail: "GitHub blocks the merge.",
      });
      return { outcome: "merged" };
    },
  );

  await run();

  expect(posted()).toEqual([opened, merged]);
  expect(routines.postPullRequestNote).toHaveBeenCalledWith({
    pr,
    scope: "linearTicketToPr/ABC-123",
    headSha: "h1",
    reason: "merge-retry",
    body: "GitHub blocks the merge.",
  });
});

test("a stopped build pushes the branch, posts its note on the ticket, sets Todo, and fails the run", async () => {
  vi.mocked(routines.buildAndReview).mockResolvedValueOnce({
    outcome: "stopped",
    reason: "rounds-exhausted",
    findings: ["Broken"],
    round: 3,
  });
  vi.mocked(steps.pushBranch).mockRejectedValueOnce(new Error("remote denied"));

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
      run: "failed",
    },
  ]);
  expect(steps.pushBranch).toHaveBeenCalledWith(worktree);
  expect(JSON.stringify(posted())).not.toContain("remote denied");
  expect(routines.publishPullRequest).not.toHaveBeenCalled();
  expect(statuses()).toEqual(["In Progress", "Todo"]);
});

test.each([
  [1, "jigs stopped work on ABC-123 before review."],
  [2, "jigs stopped work on ABC-123 in round 2, before its review."],
])("a stop in round %i before its review says so", async (round, headline) => {
  vi.mocked(routines.buildAndReview).mockResolvedValueOnce({
    outcome: "stopped",
    reason: "uncommitted",
    findings: [],
    round,
  });

  await expect(run()).rejects.toThrow(headline);

  expect(posted()[0]?.notes).not.toContain(
    "Could not push the branch; the service log has the push error.",
  );
});

test("a pull request closed without merging gets a note on the ticket, sets Todo, and fails the run", async () => {
  vi.mocked(routines.followPullRequestToOutcome).mockResolvedValueOnce({ outcome: "closed" });

  await expect(run()).rejects.toThrow("jigs stopped pull request maintenance for ABC-123.");

  expect(posted()[1]).toMatchObject({
    headline: "jigs stopped pull request maintenance for ABC-123.",
    run: "failed",
    notes: expect.arrayContaining([
      "The pull request was closed unmerged.",
      `Unfinished pull request: ${pr.url}`,
    ]),
  });
  expect(statuses()).toEqual(["In Progress", "In Review", "Todo"]);
});

test("any other failure leaves the ticket status alone and ends the session with the error", async () => {
  vi.mocked(routines.buildAndReview).mockRejectedValueOnce(new Error("boom"));

  await expect(run()).rejects.toThrow("boom");

  expect(posted()).toEqual([failed]);
  expect(statuses()).toEqual(["In Progress"]);
});

test("a stop whose status change fails posts no second ending", async () => {
  vi.mocked(routines.followPullRequestToOutcome).mockResolvedValueOnce({ outcome: "closed" });
  vi.mocked(steps.setTicketStatus)
    .mockResolvedValueOnce({} as Awaited<ReturnType<typeof steps.setTicketStatus>>)
    .mockResolvedValueOnce({} as Awaited<ReturnType<typeof steps.setTicketStatus>>)
    .mockRejectedValueOnce(new Error("no Todo state"));

  await expect(run()).rejects.toThrow("no Todo state");

  expect(posted().map((note) => note.run)).toEqual(["waiting", "failed"]);
  expect(posted()[1]?.headline).toBe("jigs stopped pull request maintenance for ABC-123.");
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
  const facts = { pr, snapshot: {} as PullRequestSnapshot };
  const prompt = prompts.maintain.resume({ ...facts, news: ["comment:5:2026-01-01"] });
  expect(prompt).toContain("New since your last turn:\n- comment:5:2026-01-01");
  expect(prompts.maintain.resume({ ...facts, news: [] })).not.toContain("New since");
  expect(prompt).toContain("https://github.com/acme/app/pull/7");
  expect(prompt).toContain("Ask for a person only when one must act before you can continue");
  expect(prompt).toContain("A check that failed for a reason you cannot see");
  expect(prompt).toContain("You are woken again on the next change to the pull request");
  expect(prompt).toContain("Checks that queue, run or pass do not wake you");
});

test("the workflow requires its two agents, Linear and GitHub", () => {
  expect(entry.requires).toEqual({
    agents: {
      builder: harnesses.codex({ model: "gpt-5.6-sol" }),
      reviewer: harnesses.claude({ model: "opus" }),
    },
    integrations: ["linear", "github"],
  });
  expect(
    entry.inputs.safeParse({ ticket: "", binding: "app", linearInstallation: "linear-acme" })
      .success,
  ).toBe(false);
});

test("attempts per update must be positive", () => {
  expect(
    entry.inputs.safeParse({
      ticket: "ABC-123",
      binding: "app",
      linearInstallation: "linear-acme",
      budget: { attemptsPerUpdate: 0 },
    }).success,
  ).toBe(false);
});
