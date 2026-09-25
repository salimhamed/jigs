import {
  type CheckRun,
  describeHarness,
  type Harness,
  harnesses,
  type MergePolicy,
  type PullRequestWake,
  type ReviewThread,
} from "@jigs-ai/jigs";
import { beforeEach, expect, test, vi } from "vitest";
import * as routines from "#jigs/routines";
import * as steps from "#jigs/steps";
import {
  type Delivery,
  DeliveryStopped,
  followPullRequest,
  implementAndReview,
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
    pullRequestGate: vi.fn(),
    postPullRequestNote: vi.fn(),
    postReviewAnswers: vi.fn(),
  };
});
vi.mock("#jigs/steps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#jigs/steps")>()),
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
  fixer: harnesses.claude({ model: "sonnet" }),
  budget: { reviewRounds: 2, ciFixes: 1, revisionRounds: 1 },
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

function gate(...wakes: PullRequestWake[]) {
  vi.mocked(routines.pullRequestGate).mockImplementation(async function* () {
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

  const approved = await implementAndReview(delivery);

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

  const error = await stopped(implementAndReview(delivery));

  expect(error.findings).toEqual(["Broken"]);
  expect(error.note()).toEqual({
    headline: "jigs stopped work on ABC-1 after 2 review round(s) without an approved change.",
    notes: ["Broken", "The work is on branch `acme/abc-1`, pushed, in the worktree at `/tmp/wt`."],
    closing: expect.stringContaining("Start another run"),
  });
});

test("uncommitted work stops the delivery before any review", async () => {
  answer(implementationReport, { responses: [] });
  at("h1", true);

  const error = await stopped(implementAndReview(delivery));

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

const failing = [{ name: "test", conclusion: "failure" }] as CheckRun[];
const thread = { rootId: 11, path: "a.ts", line: 1, comments: [] } as unknown as ReviewThread;

test("the fixer repairs CI, answers review threads, and jigs merges once ready", async () => {
  policy("jigs");
  gate(
    { kind: "ci-red", headSha: "h1", failing, mentionLogin: null },
    { kind: "review-comments", threads: [thread], body: "Please rename." },
    { kind: "merge-ready", headSha: "h3", retryNoted: false },
  );
  const replies = { answers: [{ threadId: 11, body: "Renamed." }], commitExplanation: "Renamed." };
  vi.mocked(routines.runAgent).mockImplementationOnce((async (options: { harness: Harness }) => {
    calls.push({ ...options, prompt: "", resumed: false, output: undefined });
    at("h2");
    return {
      output: undefined,
      session: {
        harness: options.harness.kind,
        id: "f1",
        descriptor: describeHarness(options.harness),
      },
    };
  }) as never);
  vi.mocked(routines.runAgent).mockImplementationOnce((async (options: {
    harness: Harness;
    prompt: string;
    resume?: unknown;
  }) => {
    calls.push({ ...options, resumed: options.resume !== undefined, output: undefined });
    at("h3");
    return { output: replies };
  }) as never);
  vi.mocked(steps.mergePullRequest).mockResolvedValue({ merged: true, mergeCommitSha: "m" });

  await followPullRequest(delivery, pr);

  expect(calls.map((call) => call.harness)).toEqual([delivery.fixer, delivery.fixer]);
  expect(calls[1]?.resumed).toBe(true);
  expect(calls[1]?.prompt).toContain("Please rename.");
  expect(calls[1]?.prompt).not.toContain("THE TASK BRIEF");
  expect(steps.pushBranch).toHaveBeenCalledTimes(2);
  expect(routines.postReviewAnswers).toHaveBeenCalledWith({
    pr,
    scope: "linearTicketToPr/ABC-1",
    answers: replies,
    committedSha: "h3",
    threads: [thread],
  });
  expect(steps.mergePullRequest).toHaveBeenCalledWith(
    pr,
    "h3",
    expect.objectContaining({ by: "jigs" }),
  );
});

test("a spent CI budget stops with the failing checks", async () => {
  policy("human");
  gate({ kind: "ci-red", headSha: "h1", failing, mentionLogin: null });

  const error = await stopped(
    followPullRequest({ ...delivery, budget: { ...delivery.budget, ciFixes: 0 } }, pr),
  );

  expect(error.findings).toEqual(["test: failure"]);
  expect(calls).toHaveLength(0);
});

test("a refused merge is noted on the pull request and the gate keeps listening", async () => {
  policy("jigs");
  gate({ kind: "merge-ready", headSha: "h1", retryNoted: false }, { kind: "closed", merged: true });
  vi.mocked(steps.mergePullRequest).mockResolvedValue({
    merged: false,
    reason: "branch protection",
    transient: false,
  } as never);

  await followPullRequest(delivery, pr);

  expect(routines.postPullRequestNote).toHaveBeenCalledWith(
    expect.objectContaining({ reason: "merge", headSha: "h1" }),
  );
});

test("with human merges, jigs waits for the merge and a close without one stops", async () => {
  policy("human");
  gate(
    { kind: "merge-ready", headSha: "h1", retryNoted: false },
    { kind: "closed", merged: false },
  );

  const error = await stopped(followPullRequest(delivery, pr));

  expect(steps.mergePullRequest).not.toHaveBeenCalled();
  expect(error.message).toBe("Pull request acme/app#7 was closed unmerged.");
});

test("a CI repair with no new clean commit marks the red head and stops", async () => {
  policy("human");
  gate({ kind: "ci-red", headSha: "h1", failing, mentionLogin: null });

  const error = await stopped(followPullRequest(delivery, pr));

  expect(calls.map((call) => call.harness)).toEqual([delivery.fixer]);
  expect(routines.postPullRequestNote).toHaveBeenCalledOnce();
  expect(routines.postPullRequestNote).toHaveBeenCalledWith(
    expect.objectContaining({ reason: "ci", headSha: "h1" }),
  );
  expect(error.message).toBe(
    "jigs stopped work on ABC-1: the CI repair produced no new clean commit.",
  );
});

test("a thrown merge is treated as transient and noted for retry", async () => {
  policy("jigs");
  gate({ kind: "merge-ready", headSha: "h1", retryNoted: false }, { kind: "closed", merged: true });
  vi.mocked(steps.mergePullRequest).mockRejectedValue(new Error("GitHub 502"));

  await followPullRequest(delivery, pr);

  expect(routines.postPullRequestNote).toHaveBeenCalledOnce();
  expect(routines.postPullRequestNote).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: "merge-retry",
      headSha: "h1",
      body: expect.stringContaining("GitHub 502"),
    }),
  );
});

test("a spent revision budget stops with the review body as the finding", async () => {
  policy("human");
  gate({ kind: "review-comments", threads: [thread], body: "Please rename." });

  const error = await stopped(
    followPullRequest({ ...delivery, budget: { ...delivery.budget, revisionRounds: 0 } }, pr),
  );

  expect(error.findings).toEqual(["Please rename."]);
  expect(calls).toHaveLength(0);
});

test("a revision that leaves uncommitted changes stops like any other", async () => {
  policy("human");
  gate({ kind: "review-comments", threads: [thread] });
  vi.mocked(routines.runAgent).mockImplementationOnce((async () => {
    at("h2", true);
    return { output: { answers: [], commitExplanation: null } };
  }) as never);

  const error = await stopped(followPullRequest(delivery, pr));

  expect(error.message).toContain("left uncommitted changes");
  expect(routines.postReviewAnswers).not.toHaveBeenCalled();
});
