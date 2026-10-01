import {
  describeHarness,
  type Harness,
  harnesses,
  type PullRequestSnapshot,
  type TicketNote,
} from "@jigs-ai/jigs";
import { beforeEach, expect, test, vi } from "vitest";
import { createHook, sleep } from "workflow";
import { z } from "zod";
import * as routines from "#jigs/routines";
import * as steps from "#jigs/steps";
import {
  type Delivery,
  DeliveryStopped,
  followPullRequest,
  implementAndReview,
  maintenanceReport,
  publish,
} from "./delivery.ts";
import { implementationReport, pullRequestDescription, reviewVerdict } from "./review.ts";

// Every session turn reaches the mocked runAgent, so each test's fake agent
// sees exactly what a real harness would be sent.
vi.mock("#jigs/routines", async (importOriginal) => {
  const { bindAgentSession } = await import("@jigs-ai/jigs/routines");
  const runAgent = vi.fn();
  return {
    ...(await importOriginal<typeof import("#jigs/routines")>()),
    runAgent,
    agentSession: bindAgentSession(runAgent),
    watchPullRequest: vi.fn(),
  };
});
vi.mock("#jigs/steps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#jigs/steps")>()),
  fetchPullRequestState: vi.fn(),
  mergePullRequest: vi.fn(),
  openPullRequest: vi.fn(),
  pushApprovedChange: vi.fn(),
  pushBranch: vi.fn(),
  readBranchState: vi.fn(),
  readWorktreeDiff: vi.fn(async () => "diff --git a/x b/x"),
  registerResource: vi.fn(),
}));
vi.mock("workflow", () => ({
  createHook: vi.fn(),
  sleep: vi.fn(async () => {}),
  getWorkflowMetadata: () => ({
    workflowRunId: "wrun_TEST",
    workflowName: "workflow//./workflows/linear-ticket-to-pr/linear-ticket-to-pr//linearTicketToPr",
  }),
}));

const worktree = {
  binding: "app",
  path: "/tmp/wt",
  branch: "acme/abc-1",
  defaultBranch: "main",
  baseSha: "base",
};
const delivery: Delivery = {
  task: { id: "id-1", key: "ABC-1", title: "Add a flag", instructions: "THE TASK BRIEF" },
  worktree,
  builder: harnesses.codex({ model: "gpt-5.6-sol" }),
  reviewer: harnesses.claude({ model: "opus" }),
  budget: { reviewRounds: 2, attemptsPerUpdate: 3 },
  mergedBy: "human",
};
const pr = { owner: "acme", repo: "app", number: 7, url: "https://github.com/acme/app/pull/7" };

type Call = { harness: Harness; prompt: string; resumed: boolean; output?: unknown };
let calls: Call[];
let answers: Map<unknown, unknown[]>;

// Answers are queued by output schema; a turn with no schema returns nothing.
function answer(schema: unknown, ...outputs: unknown[]) {
  answers.set(schema, [...(answers.get(schema) ?? []), ...outputs]);
}
let head: { headSha: string; dirty: boolean; commits: number };
const at = (headSha: string, dirty = false) => {
  head = { headSha, dirty, commits: 1 };
};

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  answers = new Map();
  at("h1");
  vi.mocked(steps.pushBranch).mockResolvedValue({ headSha: "h1" });
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue(snapshot);
  vi.mocked(routines.runAgent).mockImplementation((async (options: {
    harness: Harness;
    prompt: string;
    resume?: unknown;
    output?: unknown;
  }) => {
    calls.push({ ...options, resumed: options.resume !== undefined });
    const queued = answers.get(options.output)?.shift();
    const raw = typeof queued === "function" ? queued() : queued;
    // The real runAgent parses the answer with the caller's schema.
    const output = raw === undefined ? raw : (options.output as z.ZodType).parse(raw);
    const session = {
      harness: options.harness.kind,
      id: `s${calls.length}`,
      descriptor: describeHarness(options.harness),
    };
    return { output, session };
  }) as never);
  vi.mocked(steps.readBranchState).mockImplementation(async () => head);
});

function watch(...wakes: PullRequestSnapshot[]) {
  vi.mocked(routines.watchPullRequest).mockImplementation(async function* () {
    yield* wakes;
  });
}
const mergesBy = (by: Delivery["mergedBy"]) => {
  delivery.mergedBy = by;
};

const stopped = (promise: Promise<unknown>) =>
  promise.then(
    () => expect.unreachable("delivery should stop"),
    (error: unknown) => {
      expect(error).toBeInstanceOf(DeliveryStopped);
      expect(steps.pushBranch).toHaveBeenCalledWith(worktree);
      return error as DeliveryStopped;
    },
  );

test("a blocking finding sends the round back, and the resumed builder is told only what is new", async () => {
  answer(implementationReport, { responses: [] }, { responses: [] });
  answer(
    reviewVerdict,
    { verdict: "changes-requested", findings: [{ summary: "Missing test", blocking: true }] },
    { verdict: "approved", findings: [{ summary: "Rename x", blocking: false }] },
  );

  const approved = await implementAndReview(delivery, builder());

  expect(approved.reviewedCommit).toBe("h1");
  expect(approved.ledger.map((round) => round.verdict)).toEqual(["changes-requested", "approved"]);
  const [firstBuild, firstReview, secondBuild, secondReview] = calls;
  expect(firstBuild?.resumed).toBe(false);
  expect(firstBuild?.prompt).toContain("THE TASK BRIEF");
  expect(firstBuild?.prompt).toContain("Base commit: base");
  expect(firstBuild?.prompt).toContain("Current diff:\ndiff --git a/x b/x");
  expect(firstReview?.harness).toBe(delivery.reviewer);
  expect(secondBuild?.resumed).toBe(true);
  expect(secondBuild?.prompt).toContain("Missing test");
  expect(secondBuild?.prompt).not.toContain("THE TASK BRIEF");
  expect(secondReview?.resumed).toBe(true);
  expect(secondReview?.prompt).not.toContain("THE TASK BRIEF");
});

test("the reviewer is told no pull request or CI exists yet and to stay off GitHub", async () => {
  answer(implementationReport, { responses: [] }, { responses: [] });
  answer(
    reviewVerdict,
    { verdict: "changes-requested", findings: [{ summary: "Missing test", blocking: true }] },
    { verdict: "approved", findings: [] },
  );

  await implementAndReview(delivery, builder());

  const reviews = calls.filter((call) => call.harness === delivery.reviewer);
  expect(reviews.map((call) => call.resumed)).toEqual([false, true]);
  for (const { prompt } of reviews) {
    expect(prompt).toContain("No pull request exists yet and CI has not run");
    expect(prompt).toContain("do not look up pull requests, branches or CI status on GitHub");
    expect(prompt).toContain(
      "leave acceptance criteria about CI or the pull request to the pull-request phase that follows",
    );
  }
});

test("an exhausted review budget pushes the branch and stops with the open findings", async () => {
  answer(implementationReport, { responses: [] }, { responses: [] });
  const blocked = {
    verdict: "changes-requested",
    findings: [{ summary: "Broken", blocking: true }],
  };
  answer(reviewVerdict, blocked, blocked);

  const error = await stopped(implementAndReview(delivery, builder()));

  expect(error.findings).toEqual(["Broken"]);
  expect(error.note()).toEqual({
    headline: "jigs stopped work on ABC-1 after 2 review round(s) without an approved change.",
    notes: ["Broken", "The work is on branch `acme/abc-1`, in the worktree at `/tmp/wt`."],
    closing: expect.stringContaining("Another run starts over on a new branch"),
  });
});

test("uncommitted work stops the delivery before any review", async () => {
  answer(implementationReport, { responses: [] });
  at("h1", true);

  const error = await stopped(implementAndReview(delivery, builder()));

  expect(error.findings[0]).toContain("uncommitted changes");
  expect(error.findings[0]).toContain("git -C /tmp/wt status");
  expect(steps.pushBranch).toHaveBeenCalledWith(worktree);
  expect(calls).toHaveLength(1);
});

test("a build round that commits nothing stops the delivery before any review", async () => {
  answer(implementationReport, { responses: [] });
  head = { headSha: "base", dirty: false, commits: 0 };

  const error = await stopped(implementAndReview(delivery, builder()));

  expect(error.message).toBe("jigs stopped work on ABC-1 in review round 1.");
  expect(error.findings[0]).toContain("committed nothing on acme/abc-1");
  expect(steps.readBranchState).toHaveBeenCalledWith(worktree, "base");
  expect(calls).toHaveLength(1);
});

test("publish pushes the reviewed commit and appends the reviewer's notes", async () => {
  answer(pullRequestDescription, { title: "Add a flag", body: "Adds it." });
  vi.mocked(steps.openPullRequest).mockResolvedValue(pr);

  const opened = await publish(delivery, {
    reviewedCommit: "h1",
    ledger: [
      {
        round: 1,
        responses: [],
        verdict: "approved",
        findings: [{ summary: "Rename x", blocking: false }],
      },
    ],
  });

  expect(opened).toBe(pr);
  expect(steps.pushApprovedChange).toHaveBeenCalledWith(worktree, "h1");
  expect(calls[0]?.harness).toBe(delivery.builder);
  expect(steps.openPullRequest).toHaveBeenCalledWith({
    worktree,
    title: "Add a flag",
    body: "Adds it.\n\n## Reviewer notes\n\n- Rename x",
  });
  expect(steps.registerResource).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "pull-request", identity: "acme/app#7" }),
  );
});

test.each([
  ["a multi-line title", "Tidy setup\nand more"],
  ["a markdown heading", "# Tidy local setup files"],
  ["bold markdown", "**Tidy local setup files**"],
  ["a Title: label", "Title: Tidy local setup files"],
  ["a bold Title: label", "**Title:** Tidy local setup files"],
  ["an overly long title", "Tidy ".repeat(21)],
])("the description schema rejects %s", (_, title) => {
  expect(pullRequestDescription.safeParse({ title, body: "Adds it." }).success).toBe(false);
});

test.each(["#123 follow-up", "*.env files are ignored", "title: truncate long titles"])(
  "the description schema accepts the title %s",
  (title) => {
    expect(pullRequestDescription.safeParse({ title, body: "Adds it." }).success).toBe(true);
  },
);

test.each([
  "**Title:**\nTidy local setup files\n\n**Description:**\n## Summary",
  "# PR title and body\n\n**Title:** x",
  "**Description:**\n## Summary",
])("the description schema rejects a body with a label line: %j", (body) => {
  expect(pullRequestDescription.safeParse({ title: "Tidy setup", body }).success).toBe(false);
});

test("the description schema accepts a body line that only starts with Description", () => {
  const body = "## Summary\nDescription of the fix follows.";
  expect(pullRequestDescription.safeParse({ title: "Tidy setup", body }).success).toBe(true);
});

test("a description the schema rejects fails before any pull request opens", async () => {
  answer(pullRequestDescription, { title: "Title: Add a flag", body: "Adds it." });

  await expect(publish(delivery, { reviewedCommit: "h1", ledger: [] })).rejects.toBeInstanceOf(
    z.ZodError,
  );
  expect(steps.openPullRequest).not.toHaveBeenCalled();
});

const snapshot: PullRequestSnapshot = {
  state: "open",
  merged: false,
  draft: false,
  headSha: "h1",
  mergeState: "clean",
  labels: [],
  mergeCommitSha: null,
  ci: "green",
  failingChecks: [],
  reviews: [
    {
      id: 1,
      state: "APPROVED",
      body: "",
      user: "human",
      submittedAt: "2026-01-01",
      commitSha: "h1",
    },
  ],
  reviewThreads: [],
  conversationComments: [],
  approval: { signal: "review", state: "approved" },
};
const unapproved: PullRequestSnapshot = {
  ...snapshot,
  reviews: [],
  approval: { signal: "review", state: "none" },
};
const opened: PullRequestSnapshot = { ...unapproved, ci: "none", mergeState: "unknown" };
const comment = (id: number, body = "Please rename x.") => ({
  id,
  body,
  user: "human",
  userType: "User",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});
const withComment = (state: PullRequestSnapshot, id = 1, body?: string) => ({
  ...state,
  conversationComments: [...state.conversationComments, comment(id, body)],
});
// Approved, green and clean, with a comment the builder has to read first.
const commented = withComment(snapshot);
const failed = (state: PullRequestSnapshot, ...names: string[]): PullRequestSnapshot => ({
  ...state,
  ci: "red",
  failingChecks: names.map((name) => ({ name, conclusion: "failure", url: `https://ci/${name}` })),
});
const closed = { ...snapshot, state: "closed" as const, merged: true };
const finished = { status: "finished", summary: "All requests addressed." };
const builder = () =>
  routines.agentSession({ name: "builder", harness: delivery.builder, cwd: worktree.path });

const onNeedsHuman = vi.fn(async (_note: TicketNote) => {});
const follow = (config = delivery) => followPullRequest(config, pr, builder(), { onNeedsHuman });
const notes = () => onNeedsHuman.mock.calls.map(([note]) => note);

test("the implementation builder resumes to judge the PR and merges only after GitHub readiness", async () => {
  mergesBy("jigs");
  answer(implementationReport, { responses: [] });
  answer(reviewVerdict, { verdict: "approved", findings: [] });
  answer(maintenanceReport, finished);
  watch(commented);
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue(commented);
  vi.mocked(steps.mergePullRequest).mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  const session = builder();
  await implementAndReview(delivery, session);
  await followPullRequest(delivery, pr, session, { onNeedsHuman });
  expect(calls[2]?.harness).toBe(delivery.builder);
  expect(calls[2]?.resumed).toBe(true);
  expect(calls[2]?.prompt).not.toContain("THE TASK BRIEF");
  expect(steps.mergePullRequest).toHaveBeenCalledWith(worktree, pr, "h1");
});

test("an unavailable session gets the task, local diff and PR facts in a fresh prompt", async () => {
  mergesBy("human");
  answer(maintenanceReport, finished);
  watch(commented, closed);
  await follow();
  expect(calls[0]?.prompt).toContain("THE TASK BRIEF");
  expect(calls[0]?.prompt).toContain("Current diff:");
  expect(calls[0]?.prompt).toContain(pr.url);
  expect(calls[0]?.prompt).toContain("Current GitHub facts:");
});

test("the maintenance prompt says when to wait, when to ask for a person, and what wakes the builder", async () => {
  mergesBy("human");
  answer(maintenanceReport, finished);
  watch(commented, closed);
  await follow();
  const prompt = calls[0]?.prompt;
  expect(prompt).toContain(
    "a check failed for a reason you cannot see and you are waiting for someone to re-run it",
  );
  expect(prompt).toContain("needs-human only when a person must act");
  expect(prompt).toContain("You are woken again on the next change to the pull request");
  expect(prompt).toContain("Checks that queue, run or pass do not wake you");
});

const stoppedMaintenance = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => expect.unreachable("maintenance should stop"),
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(DeliveryStopped);
  expect(steps.pushBranch).not.toHaveBeenCalled();
  return error as DeliveryStopped;
};

test("attempt allowance resets for every update and permits more than six updates", async () => {
  mergesBy("human");
  const updates = Array.from({ length: 8 }, (_, i) => withComment(snapshot, i));
  answer(maintenanceReport, ...updates.map(() => finished));
  watch(...updates, closed);
  await follow({ ...delivery, budget: { ...delivery.budget, attemptsPerUpdate: 1 } });
  expect(calls).toHaveLength(8);
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("a human merger means jigs never merges", async () => {
  mergesBy("human");
  answer(maintenanceReport, finished);
  watch(snapshot, commented, closed);
  await follow();
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("closed snapshots run no agent and closing without merging stops without a push", async () => {
  mergesBy("human");
  watch({ ...closed, merged: false });
  const error = await stoppedMaintenance(follow());
  expect(error.findings[0]).toContain("closed unmerged");
  expect(calls).toHaveLength(0);
});

test("CI moving from none through pending to green wakes no builder", async () => {
  mergesBy("human");
  watch(
    opened,
    { ...opened, ci: "pending" },
    { ...opened, ci: "green", mergeState: "clean" },
    closed,
  );
  await follow();
  expect(calls).toHaveLength(0);
});

test("an approval arriving after CI goes green merges without a builder turn", async () => {
  mergesBy("jigs");
  vi.mocked(steps.mergePullRequest).mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  watch(opened, { ...opened, ci: "pending" }, { ...unapproved, ci: "green" }, snapshot);
  await follow();
  expect(calls).toHaveLength(0);
  expect(steps.mergePullRequest).toHaveBeenCalledOnce();
  expect(steps.mergePullRequest).toHaveBeenCalledWith(worktree, pr, "h1");
});

test("a newly failed check wakes the builder once; the same failure on the same head does not", async () => {
  mergesBy("human");
  answer(maintenanceReport, { status: "pending", summary: "Waiting for a re-run." });
  const red = failed(opened, "build");
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue(red);
  const rerun = failed(opened, "build");
  watch(opened, red, { ...opened, ci: "pending" }, { ...rerun, mergeState: "blocked" }, closed);
  await follow();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.prompt).toContain('"name":"build"');
});

test("a conflict with the base wakes the builder", async () => {
  mergesBy("human");
  answer(maintenanceReport, finished);
  watch({ ...opened, mergeState: "dirty" }, closed);
  await follow();
  expect(calls).toHaveLength(1);
});

test("needs-human posts a note and keeps watching; a later approval on a green head merges", async () => {
  mergesBy("jigs");
  answer(maintenanceReport, {
    status: "needs-human",
    summary: "The CodeBuild check needs a re-run.",
  });
  const waiting = withComment({ ...unapproved, ci: "pending" });
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue(waiting);
  vi.mocked(steps.mergePullRequest).mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  watch(waiting, { ...waiting, ci: "green" }, withComment(snapshot));
  await follow();
  expect(calls).toHaveLength(1);
  expect(notes()).toHaveLength(1);
  expect(notes()[0]?.notes[0]).toContain("The CodeBuild check needs a re-run.");
  expect(steps.mergePullRequest).toHaveBeenCalledOnce();
});

test.each(["pending", "needs-human"])(
  "a %s report does not hold back a merge a person approved on a green head",
  async (status) => {
    mergesBy("jigs");
    answer(maintenanceReport, { status, summary: "Waiting for a decision." });
    vi.mocked(steps.fetchPullRequestState).mockResolvedValue(commented);
    vi.mocked(steps.mergePullRequest).mockResolvedValue({ merged: true, mergeCommitSha: "m" });
    watch(commented);
    await follow();
    expect(steps.mergePullRequest).toHaveBeenCalledOnce();
  },
);

test.each([failed(commented, "build"), withComment(unapproved), { ...commented, draft: true }])(
  "agent completion cannot replace GitHub readiness %#",
  async (state) => {
    mergesBy("jigs");
    answer(maintenanceReport, finished);
    watch(state, closed);
    vi.mocked(steps.fetchPullRequestState).mockResolvedValue(state);
    await follow();
    expect(steps.mergePullRequest).not.toHaveBeenCalled();
  },
);

test("a successful push aligning local and published heads defers merging the new code", async () => {
  mergesBy("jigs");
  answer(maintenanceReport, () => {
    at("h2");
    return finished;
  });
  watch(commented, closed);
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue({ ...commented, headSha: "h2" });
  await follow();
  expect(calls).toHaveLength(1);
  expect(sleep).not.toHaveBeenCalled();
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("the builder's own reply during its turn wakes nothing, and an approved green PR then merges", async () => {
  mergesBy("jigs");
  answer(maintenanceReport, finished);
  const replied = withComment(commented, 2, "Renamed x.");
  watch(commented, replied);
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue(replied);
  vi.mocked(steps.mergePullRequest).mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  await follow();
  expect(calls).toHaveLength(1);
  expect(steps.mergePullRequest).toHaveBeenCalledOnce();
});

test("a check failing during the builder's turn is not mistaken for its own and wakes it", async () => {
  mergesBy("human");
  answer(maintenanceReport, finished, finished);
  const red = failed(commented, "build");
  vi.mocked(steps.fetchPullRequestState).mockResolvedValueOnce(red).mockResolvedValue(red);
  watch(commented, red, closed);
  await follow();
  expect(calls).toHaveLength(2);
});

test("a transient merge refusal is retried after a durable wait, without a new watcher yield", async () => {
  mergesBy("jigs");
  vi.mocked(steps.mergePullRequest)
    .mockResolvedValueOnce({
      merged: false,
      reason: "GitHub reports the merge state as unknown",
      transient: true,
    })
    .mockResolvedValueOnce({ merged: true, mergeCommitSha: "m" });
  watch(snapshot);
  await follow();
  expect(steps.mergePullRequest).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith("30s");
  expect(notes()).toEqual([]);
});

test("a merge step that throws is retried like a transient refusal", async () => {
  mergesBy("jigs");
  vi.mocked(steps.mergePullRequest)
    .mockRejectedValueOnce(new Error("GitHub 502"))
    .mockResolvedValueOnce({ merged: true, mergeCommitSha: "m" });
  watch(snapshot);
  await follow();
  expect(steps.mergePullRequest).toHaveBeenCalledTimes(2);
  expect(steps.pushBranch).not.toHaveBeenCalled();
});

test("a merge state GitHub is still computing is polled until it reads clean", async () => {
  mergesBy("jigs");
  vi.mocked(steps.mergePullRequest)
    .mockResolvedValueOnce({ merged: false, reason: "computing", transient: true })
    .mockResolvedValueOnce({ merged: true, mergeCommitSha: "m" });
  vi.mocked(steps.fetchPullRequestState)
    .mockResolvedValueOnce({ ...snapshot, mergeState: "unknown" })
    .mockResolvedValueOnce(snapshot);
  watch(snapshot);
  await follow();
  expect(steps.mergePullRequest).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledTimes(2);
});

test("after a transient refusal, a not-ready read that settles back to the yielded state still merges", async () => {
  mergesBy("jigs");
  vi.mocked(steps.mergePullRequest)
    .mockResolvedValueOnce({ merged: false, reason: "CI is pending", transient: true })
    .mockResolvedValueOnce({ merged: true, mergeCommitSha: "m" });
  vi.mocked(steps.fetchPullRequestState)
    .mockResolvedValueOnce({ ...snapshot, mergeState: "blocked", ci: "pending" })
    .mockResolvedValueOnce(snapshot);
  watch(snapshot);
  await follow();
  expect(steps.mergePullRequest).toHaveBeenCalledTimes(2);
  expect(notes()).toEqual([]);
});

test("merge retries give up after ten tries with one note, then watching goes on", async () => {
  mergesBy("jigs");
  vi.mocked(steps.mergePullRequest).mockRejectedValue(new Error("GitHub 502"));
  watch(snapshot, closed);
  await follow();
  expect(steps.mergePullRequest).toHaveBeenCalledTimes(10);
  expect(sleep).toHaveBeenCalledTimes(9);
  expect(notes().map((note) => note.notes[0])).toEqual([
    "Could not merge the pull request after 10 tries: Error: GitHub 502",
  ]);
});

test("a merge refused for a reason no wake changes is noted once", async () => {
  mergesBy("jigs");
  vi.mocked(steps.mergePullRequest).mockResolvedValue({
    merged: false,
    reason: "merge method disabled",
    transient: false,
  });
  watch(snapshot, { ...snapshot, labels: ["a"] }, closed);
  await follow();
  expect(steps.mergePullRequest).toHaveBeenCalledTimes(2);
  expect(sleep).not.toHaveBeenCalled();
  expect(notes().map((note) => note.notes[0])).toEqual([
    "Could not merge the pull request: merge method disabled",
  ]);
});

test("the same needs-human note is not posted twice in a row", async () => {
  mergesBy("human");
  const stuck = { status: "needs-human", summary: "A person must re-run CodeBuild." };
  answer(maintenanceReport, stuck, stuck);
  watch(commented, withComment(commented, 2), closed);
  vi.mocked(steps.fetchPullRequestState)
    .mockResolvedValueOnce(commented)
    .mockResolvedValue(withComment(commented, 2));
  await follow();
  expect(calls).toHaveLength(2);
  expect(notes()).toHaveLength(1);
});

test.each(["dirty", "unpublished"])(
  "%s local work that recovery could not settle is never merged over",
  async (kind) => {
    mergesBy("jigs");
    at(kind === "dirty" ? "h1" : "h2", kind === "dirty");
    answer(maintenanceReport, finished, finished);
    vi.mocked(steps.fetchPullRequestState).mockResolvedValue(commented);
    watch(commented, { ...commented, labels: ["later"] }, closed);
    await follow({ ...delivery, budget: { ...delivery.budget, attemptsPerUpdate: 2 } });
    expect(calls).toHaveLength(2);
    expect(notes()).toHaveLength(1);
    expect(steps.mergePullRequest).not.toHaveBeenCalled();
  },
);

test("a person pushing past local work that is on the PR does not hold back a merge", async () => {
  mergesBy("jigs");
  vi.mocked(steps.mergePullRequest).mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  const pushed = {
    ...snapshot,
    headSha: "h3",
    reviews: snapshot.reviews.map((review) => ({ ...review, commitSha: "h3" })),
  };
  watch(unapproved, pushed);
  await follow();
  expect(calls).toHaveLength(0);
  expect(steps.mergePullRequest).toHaveBeenCalledWith(worktree, pr, "h3");
});

test("local commits that never reached the PR still hold back a merge after a person pushes", async () => {
  mergesBy("jigs");
  at("h2");
  answer(maintenanceReport, finished);
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue(commented);
  const pushed = {
    ...commented,
    headSha: "h3",
    reviews: commented.reviews.map((review) => ({ ...review, commitSha: "h3" })),
  };
  watch(commented, pushed, closed);
  await follow({ ...delivery, budget: { ...delivery.budget, attemptsPerUpdate: 1 } });
  expect(calls).toHaveLength(1);
  expect(notes()).toHaveLength(1);
  expect(notes()[0]?.notes[0]).toContain("holds back the merge");
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("a dirty worktree is recovered on the first yield with no wake fact, and never merged over", async () => {
  mergesBy("jigs");
  at("h1", true);
  answer(maintenanceReport, finished);
  watch(snapshot, closed);
  await follow({ ...delivery, budget: { ...delivery.budget, attemptsPerUpdate: 1 } });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.prompt).toContain("Recovery required:");
  expect(notes()).toHaveLength(1);
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("a worktree edited while parked is recovered on the next yield", async () => {
  mergesBy("human");
  answer(maintenanceReport, finished, () => {
    at("h1");
    return finished;
  });
  vi.mocked(routines.watchPullRequest).mockImplementation(async function* () {
    yield commented;
    at("h1", true);
    yield { ...commented, labels: ["later"] };
    yield closed;
  });
  await follow();
  expect(calls).toHaveLength(2);
  expect(calls[1]?.prompt).toContain("dirty (uncommitted changes remain)");
});

test("local state is read again right before merging", async () => {
  mergesBy("jigs");
  vi.mocked(steps.readBranchState)
    .mockResolvedValueOnce({ headSha: "h1", dirty: false, commits: 1 })
    .mockResolvedValueOnce({ headSha: "h1", dirty: true, commits: 1 });
  watch(snapshot, closed);
  await follow();
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("a review requesting changes during the builder's turn is not absorbed, and blocks the merge until handled", async () => {
  mergesBy("jigs");
  answer(maintenanceReport, finished, finished);
  const requested = {
    ...commented,
    reviews: [
      ...commented.reviews,
      {
        id: 2,
        state: "CHANGES_REQUESTED",
        body: "",
        user: "other",
        submittedAt: "2026-01-02",
        commitSha: "h1",
      },
    ],
  };
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue(requested);
  vi.mocked(steps.mergePullRequest).mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  watch(commented, requested);
  await follow();
  expect(calls).toHaveLength(2);
  expect(vi.mocked(steps.mergePullRequest).mock.invocationCallOrder[0]).toBeGreaterThan(
    vi.mocked(routines.runAgent).mock.invocationCallOrder[1] ?? Infinity,
  );
});

test("needs-human over unpublished local work says it holds back the merge", async () => {
  mergesBy("jigs");
  at("h1", true);
  answer(maintenanceReport, { status: "needs-human", summary: "Stuck." });
  watch(commented, closed);
  await follow();
  expect(notes()[0]?.notes[0]).toContain("holds back the merge");
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("once the retained work is published, a ready PR merges again", async () => {
  mergesBy("jigs");
  at("h1", true);
  answer(maintenanceReport, finished);
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue(commented);
  vi.mocked(steps.mergePullRequest).mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  const published = {
    ...commented,
    headSha: "h2",
    reviews: commented.reviews.map((review) => ({ ...review, commitSha: "h2" })),
  };
  vi.mocked(routines.watchPullRequest).mockImplementation(async function* () {
    yield commented;
    at("h2");
    yield published;
  });
  await follow({ ...delivery, budget: { ...delivery.budget, attemptsPerUpdate: 1 } });
  expect(steps.mergePullRequest).toHaveBeenCalledWith(worktree, pr, "h2");
});

test("a failed implementation preservation push does not hide why delivery stopped", async () => {
  answer(implementationReport, { responses: [] });
  at("h1", true);
  vi.mocked(steps.pushBranch).mockRejectedValueOnce(new Error("remote denied"));
  const error = await stopped(implementAndReview(delivery, builder()));
  expect(error.message).toContain("review round 1");
  expect(error.findings.at(-1)).toContain("Recover the work from /tmp/wt");
});

test("reordered GitHub collections do not prevent a ready merge", async () => {
  mergesBy("jigs");
  answer(maintenanceReport, finished);
  const state = { ...commented, labels: ["one", "two"] };
  watch(state);
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue({ ...state, labels: ["two", "one"] });
  vi.mocked(steps.mergePullRequest).mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  await follow();
  expect(steps.mergePullRequest).toHaveBeenCalledOnce();
});

test.each(["jigs", "human"] as const)(
  "a forgotten push recovers immediately in %s mode without another watcher yield",
  async (by) => {
    mergesBy(by);
    let published = "h1";
    vi.mocked(steps.fetchPullRequestState).mockImplementation(async () => ({
      ...commented,
      headSha: published,
    }));
    answer(
      maintenanceReport,
      () => {
        at("h2");
        return finished;
      },
      () => {
        published = "h2";
        return finished;
      },
    );
    watch(commented, closed);
    await follow();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.resumed).toBe(true);
    expect(calls[1]?.prompt).toContain("Recovery required:");
    expect(calls[1]?.prompt).toContain("Local HEAD: h2. Published PR head: h1.");
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(steps.pushBranch).not.toHaveBeenCalled();
  },
);

test("a person pushing ahead of the builder is not a recovery reason", async () => {
  mergesBy("human");
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue({ ...commented, headSha: "h3" });
  answer(maintenanceReport, finished);
  watch(commented, closed);
  await follow();
  expect(calls).toHaveLength(1);
});

test("dirty work is recovered immediately without waiting or another watcher yield", async () => {
  mergesBy("human");
  answer(
    maintenanceReport,
    () => {
      at("h1", true);
      return { status: "pending", summary: "Not committed yet." };
    },
    () => {
      at("h1");
      return finished;
    },
  );
  watch(commented, closed);
  await follow();
  expect(calls).toHaveLength(2);
  expect(calls[1]?.prompt).toContain("dirty (uncommitted changes remain)");
  expect(sleep).not.toHaveBeenCalled();
});

test.each(["dirty", "unpublished"])(
  "persistent %s state exhausts only this update's allowance, notes it and keeps watching",
  async (kind) => {
    mergesBy("human");
    at(kind === "dirty" ? "h1" : "h2", kind === "dirty");
    answer(maintenanceReport, finished, finished);
    watch(commented, closed);
    await follow({ ...delivery, budget: { ...delivery.budget, attemptsPerUpdate: 2 } });
    expect(calls).toHaveLength(2);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]?.notes[0]).toContain("Exhausted 2 attempts for this pull request update");
    expect(notes()[0]?.notes[0]).toContain(`Local HEAD: ${head.headSha}`);
    expect(steps.pushBranch).not.toHaveBeenCalled();
  },
);

test("GitHub head lag resolves during bounded rechecks without another agent attempt", async () => {
  mergesBy("human");
  at("h2");
  answer(maintenanceReport, finished);
  watch(commented, closed);
  vi.mocked(steps.fetchPullRequestState)
    .mockResolvedValueOnce(commented)
    .mockResolvedValueOnce(commented)
    .mockResolvedValueOnce({ ...commented, headSha: "h2" });
  await follow({ ...delivery, budget: { ...delivery.budget, attemptsPerUpdate: 1 } });
  expect(calls).toHaveLength(1);
  expect(sleep).toHaveBeenCalledTimes(2);
  expect(steps.fetchPullRequestState).toHaveBeenCalledTimes(3);
});

test.each([true, false])(
  "PR closure while rechecking mismatched heads is handled (merged=%s)",
  async (merged) => {
    mergesBy("human");
    at("h2");
    answer(maintenanceReport, finished);
    watch(commented);
    vi.mocked(steps.fetchPullRequestState)
      .mockResolvedValueOnce(commented)
      .mockResolvedValueOnce({ ...closed, merged });
    if (merged) await follow();
    else await stoppedMaintenance(follow());
    expect(calls).toHaveLength(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  },
);

test("needs-human with mismatched local state notes it without spending recovery attempts", async () => {
  mergesBy("human");
  at("h2", true);
  answer(maintenanceReport, { status: "needs-human", summary: "Credentials unavailable." });
  watch(commented, closed);
  await follow();
  expect(notes()[0]?.notes[0]).toContain("Credentials unavailable");
  expect(calls).toHaveLength(1);
  expect(sleep).not.toHaveBeenCalled();
});

test("a fresh recovery prompt includes the same actionable facts when no session survives", async () => {
  mergesBy("human");
  const run = vi
    .fn()
    .mockImplementationOnce(async (turn) => {
      at("h1", true);
      expect(await turn.fresh()).toContain("THE TASK BRIEF");
      return finished;
    })
    .mockImplementationOnce(async (turn) => {
      const prompt = await turn.fresh();
      expect(prompt).toContain("THE TASK BRIEF");
      expect(prompt).toContain("Recovery required:");
      expect(prompt).toContain("dirty (uncommitted changes remain)");
      at("h1");
      return finished;
    });
  watch(commented, closed);
  await followPullRequest(delivery, pr, { harness: delivery.builder, run }, { onNeedsHuman });
  expect(run).toHaveBeenCalledTimes(2);
});

async function useRealWatcher(states: PullRequestSnapshot[]) {
  const actual = await vi.importActual<typeof import("#jigs/routines")>("#jigs/routines");
  vi.mocked(routines.watchPullRequest).mockImplementation(actual.watchPullRequest);
  const dispose = vi.fn();
  const wake = vi.fn(async () => undefined);
  vi.mocked(createHook).mockReturnValue({
    getConflict: async () => null,
    // biome-ignore lint/suspicious/noThenProperty: the real Workflow hook is thenable
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      wake().then(resolve, reject),
    dispose,
  } as unknown as ReturnType<typeof createHook>);
  const remaining = [...states];
  vi.mocked(steps.fetchPullRequestState).mockImplementation(async () => {
    const state = remaining.shift();
    if (state === undefined) throw new Error("Unexpected extra PR read");
    return state;
  });
  return { dispose, wake, remaining };
}

test("real watcher does not repeat facts already assessed during recovery but delivers genuinely new facts", async () => {
  mergesBy("human");
  const recovered = { ...commented, headSha: "h2" };
  const changed = withComment(recovered, 2, "new-feedback");
  // Fetched by the watcher, never by a builder turn, so it is not the builder's own.
  // Initial watch, turn read, two lag checks, recovery read, watch of the
  // already-assessed facts, new watch, turn read, then closure.
  const hook = await useRealWatcher([
    commented,
    commented,
    commented,
    commented,
    recovered,
    recovered,
    changed,
    changed,
    closed,
  ]);
  answer(
    maintenanceReport,
    () => {
      at("h2");
      return finished;
    },
    finished,
    finished,
  );
  await follow();
  expect(calls).toHaveLength(3);
  expect(calls[1]?.prompt).toContain("Recovery required:");
  expect(calls[1]?.prompt).toContain("Local HEAD: h2. Published PR head: h1.");
  expect(calls[2]?.prompt).toContain("new-feedback");
  expect(hook.remaining).toHaveLength(0);
  expect(hook.wake).toHaveBeenCalledTimes(3);
  expect(hook.dispose).toHaveBeenCalledOnce();
});

test("real watcher still runs the builder for unseen facts first fetched after its turn", async () => {
  mergesBy("human");
  const changed = { ...commented, mergeState: "dirty" };
  const hook = await useRealWatcher([commented, changed, changed, changed, closed]);
  answer(maintenanceReport, finished, finished);
  await follow();
  expect(calls).toHaveLength(2);
  expect(calls[0]?.prompt).not.toContain('"mergeState":"dirty"');
  expect(calls[1]?.prompt).toContain('"mergeState":"dirty"');
  expect(hook.remaining).toHaveLength(0);
  expect(hook.dispose).toHaveBeenCalledOnce();
});

test("a needs-human note links the pull request and says jigs is still watching it", async () => {
  mergesBy("human");
  watch(commented, closed);
  answer(maintenanceReport, { status: "needs-human", summary: "Please inspect the conflict." });
  await follow();
  expect(notes()).toEqual([
    {
      headline: "jigs needs a person to move the pull request for ABC-1 forward.",
      notes: [
        "The builder needs a person: Please inspect the conflict.",
        `Pull request: ${pr.url}`,
        "The work is on branch `acme/abc-1`, in the worktree at `/tmp/wt`.",
      ],
      closing:
        "jigs is still watching the pull request: the next change to it, such as a re-run check, a new comment or review, or an approval, picks the work back up.",
    },
  ]);
});
