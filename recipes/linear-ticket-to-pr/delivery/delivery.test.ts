import {
  describeHarness,
  type Harness,
  harnesses,
  type MergePolicy,
  type PullRequestSnapshot,
} from "@jigs-ai/jigs";
import { beforeEach, expect, test, vi } from "vitest";
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
  resolveMergePolicy: vi.fn(),
  resolveRepository: vi.fn(async () => ({ owner: "acme", repo: "app" })),
}));
vi.mock("workflow", () => ({
  getWorkflowMetadata: () => ({
    workflowRunId: "wrun_TEST",
    workflowName: "workflow//./workflows/linear-ticket-to-pr/linear-ticket-to-pr//linearTicketToPr",
  }),
}));

const worktree = { path: "/tmp/wt", branch: "acme/abc-1", defaultBranch: "main", baseSha: "base" };
const delivery: Delivery = {
  task: { id: "id-1", key: "ABC-1", title: "Add a flag", instructions: "THE TASK BRIEF" },
  worktree,
  binding: "app",
  builder: harnesses.codex({ model: "gpt-5.6-sol" }),
  reviewer: harnesses.claude({ model: "opus" }),
  budget: { reviewRounds: 2, prTurns: 6 },
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
  vi.mocked(routines.runAgent).mockImplementation((async (options: {
    harness: Harness;
    prompt: string;
    resume?: unknown;
    output?: unknown;
  }) => {
    calls.push({ ...options, resumed: options.resume !== undefined });
    const output = answers.get(options.output)?.shift();
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
const policy = (by: "jigs" | "human") =>
  vi.mocked(steps.resolveMergePolicy).mockResolvedValue({
    by,
    method: "squash",
    approval: { kind: "review" },
  } as MergePolicy);

const stopped = (promise: Promise<unknown>) =>
  promise.then(
    () => expect.unreachable("delivery should stop"),
    (error: unknown) => {
      expect(error).toBeInstanceOf(DeliveryStopped);
      expect(steps.pushBranch).toHaveBeenCalledWith(worktree.path, worktree.branch);
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
    closing: expect.stringContaining("Start another run"),
  });
});

test("uncommitted work stops the delivery before any review", async () => {
  answer(implementationReport, { responses: [] });
  at("h1", true);

  const error = await stopped(implementAndReview(delivery, builder()));

  expect(error.findings[0]).toContain("uncommitted changes");
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
  expect(steps.pushApprovedChange).toHaveBeenCalledWith(worktree.path, worktree.branch, "h1");
  expect(calls[0]?.harness).toBe(delivery.builder);
  expect(steps.openPullRequest).toHaveBeenCalledWith({
    repo: { owner: "acme", repo: "app" },
    head: worktree.branch,
    base: "main",
    title: "Add a flag",
    body: "Adds it.\n\n## Reviewer notes\n\n- Rename x",
  });
  expect(steps.registerResource).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "pull-request", identity: "acme/app#7" }),
  );
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
};
const closed = { ...snapshot, state: "closed" as const, merged: true };
const finished = { status: "finished", summary: "All requests addressed." };
const builder = () =>
  routines.agentSession({ name: "builder", harness: delivery.builder, cwd: worktree.path });

const follow = (config = delivery) => followPullRequest(config, pr, builder());

test("the implementation builder resumes to judge the PR and merges only after GitHub readiness", async () => {
  policy("jigs");
  answer(implementationReport, { responses: [] });
  answer(reviewVerdict, { verdict: "approved", findings: [] });
  answer(maintenanceReport, finished);
  watch(snapshot);
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue(snapshot);
  vi.mocked(steps.mergePullRequest).mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  const session = builder();
  await implementAndReview(delivery, session);
  await followPullRequest(delivery, pr, session);
  expect(calls[2]?.harness).toBe(delivery.builder);
  expect(calls[2]?.resumed).toBe(true);
  expect(calls[2]?.prompt).not.toContain("THE TASK BRIEF");
  expect(steps.mergePullRequest).toHaveBeenCalledWith(
    pr,
    "h1",
    expect.objectContaining({ by: "jigs" }),
  );
});

test("an unavailable session gets the task, local diff and PR facts in a fresh prompt", async () => {
  policy("human");
  answer(maintenanceReport, finished);
  watch(snapshot, closed);
  await follow();
  expect(calls[0]?.prompt).toContain("THE TASK BRIEF");
  expect(calls[0]?.prompt).toContain("Current diff:");
  expect(calls[0]?.prompt).toContain(pr.url);
  expect(calls[0]?.prompt).toContain("Current GitHub facts:");
});

test("a spent factory budget stops with the unfinished PR and runs no agent", async () => {
  policy("human");
  watch(snapshot);
  const error = await stopped(follow({ ...delivery, budget: { ...delivery.budget, prTurns: 0 } }));
  expect(error.findings).toEqual([`Unfinished pull request: ${pr.url}`]);
  expect(calls).toHaveLength(0);
});

test("each agent invocation including doing nothing spends one turn", async () => {
  policy("human");
  answer(maintenanceReport, finished);
  watch(snapshot, { ...snapshot, labels: ["changed"] });
  await stopped(follow({ ...delivery, budget: { ...delivery.budget, prTurns: 1 } }));
  expect(calls).toHaveLength(1);
});

test("human merge policy never merges and closed snapshots do not spend the budget", async () => {
  policy("human");
  answer(maintenanceReport, finished);
  watch(snapshot, closed);
  await follow({ ...delivery, budget: { ...delivery.budget, prTurns: 1 } });
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("closing without merging stops", async () => {
  policy("human");
  watch({ ...closed, merged: false });
  const error = await stopped(follow());
  expect(error.message).toContain("closed unmerged");
});

test.each(["pending", "needs-human"])("%s does not authorize a merge", async (status) => {
  policy("jigs");
  answer(maintenanceReport, { status, summary: "Waiting for a decision." });
  watch(snapshot, closed);
  if (status === "needs-human") await stopped(follow());
  else await follow();
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test.each([
  { ...snapshot, ci: "red" as const },
  { ...snapshot, reviews: [] },
  { ...snapshot, draft: true },
])("agent completion cannot replace GitHub readiness %#", async (state) => {
  policy("jigs");
  answer(maintenanceReport, finished);
  watch(state, closed);
  await follow();
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("local changes to the head require another snapshot before merging", async () => {
  policy("jigs");
  answer(maintenanceReport, finished);
  watch(snapshot, closed);
  at("h2");
  await follow();
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("new feedback arriving during the agent turn must be judged before merging", async () => {
  policy("jigs");
  answer(maintenanceReport, finished);
  watch(snapshot, closed);
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue({ ...snapshot, reviews: [] });
  await follow();
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("uncommitted maintenance stops without merging", async () => {
  policy("jigs");
  answer(maintenanceReport, finished);
  watch(snapshot);
  at("h1", true);
  const error = await stopped(follow());
  expect(error.message).toContain("uncommitted changes");
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("a failed merge stops clearly instead of waiting forever on unchanged facts", async () => {
  policy("jigs");
  answer(maintenanceReport, finished);
  watch(snapshot);
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue(snapshot);
  vi.mocked(steps.mergePullRequest).mockRejectedValue(new Error("GitHub 502"));
  const error = await stopped(follow());
  expect(error.findings[0]).toContain("GitHub 502");
});

test("a failed preservation push does not hide why the delivery stopped", async () => {
  policy("human");
  watch(snapshot);
  vi.mocked(steps.pushBranch).mockRejectedValueOnce(new Error("remote denied"));
  const error = await stopped(follow({ ...delivery, budget: { ...delivery.budget, prTurns: 0 } }));
  expect(error.message).toContain("0 pull request agent turn");
  expect(error.findings.at(-1)).toContain("Recover the work from /tmp/wt");
});

test("reordered GitHub collections do not prevent a ready merge", async () => {
  policy("jigs");
  answer(maintenanceReport, finished);
  const state = { ...snapshot, labels: ["one", "two"] };
  watch(state);
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue({ ...state, labels: ["two", "one"] });
  vi.mocked(steps.mergePullRequest).mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  await follow();
  expect(steps.mergePullRequest).toHaveBeenCalledOnce();
});
