import {
  describeHarness,
  type Harness,
  harnesses,
  type MergePolicy,
  type PullRequestSnapshot,
} from "@jigs-ai/jigs";
import { beforeEach, expect, test, vi } from "vitest";
import { createHook, sleep } from "workflow";
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
    const output = typeof queued === "function" ? queued() : queued;
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
  policy("human");
  const updates = Array.from({ length: 8 }, (_, i) => ({ ...snapshot, labels: [`update-${i}`] }));
  answer(maintenanceReport, ...updates.map(() => finished));
  watch(...updates, closed);
  await follow({ ...delivery, budget: { ...delivery.budget, attemptsPerUpdate: 1 } });
  expect(calls).toHaveLength(8);
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("human merge policy never merges", async () => {
  policy("human");
  answer(maintenanceReport, finished);
  watch(snapshot, closed);
  await follow();
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("closed snapshots run no agent and closing without merging stops without a push", async () => {
  policy("human");
  watch({ ...closed, merged: false });
  const error = await stoppedMaintenance(follow());
  expect(error.findings[0]).toContain("closed unmerged");
  expect(calls).toHaveLength(0);
});

test.each(["pending", "needs-human"])("%s does not authorize a merge", async (status) => {
  policy("jigs");
  answer(maintenanceReport, { status, summary: "Waiting for a decision." });
  watch(snapshot, closed);
  if (status === "needs-human") await stoppedMaintenance(follow());
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
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue(state);
  await follow();
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("a successful push aligning local and published heads defers merging the new code", async () => {
  policy("jigs");
  answer(maintenanceReport, () => {
    at("h2");
    return finished;
  });
  watch(snapshot, closed);
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue({ ...snapshot, headSha: "h2" });
  await follow();
  expect(calls).toHaveLength(1);
  expect(sleep).not.toHaveBeenCalled();
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

test("a failed merge stops clearly without an automatic push", async () => {
  policy("jigs");
  answer(maintenanceReport, finished);
  watch(snapshot);
  vi.mocked(steps.mergePullRequest).mockRejectedValue(new Error("GitHub 502"));
  const error = await stoppedMaintenance(follow());
  expect(error.findings[0]).toContain("GitHub 502");
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
  policy("jigs");
  answer(maintenanceReport, finished);
  const state = { ...snapshot, labels: ["one", "two"] };
  watch(state);
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue({ ...state, labels: ["two", "one"] });
  vi.mocked(steps.mergePullRequest).mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  await follow();
  expect(steps.mergePullRequest).toHaveBeenCalledOnce();
});

test.each(["jigs", "human"] as const)(
  "a forgotten push recovers immediately in %s mode without another watcher yield",
  async (by) => {
    policy(by);
    let published = "h1";
    vi.mocked(steps.fetchPullRequestState).mockImplementation(async () => ({
      ...snapshot,
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
    watch(snapshot, closed);
    await follow();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.resumed).toBe(true);
    expect(calls[1]?.prompt).toContain("Recovery required:");
    expect(calls[1]?.prompt).toContain("Local HEAD: h2. Published PR head: h1.");
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(steps.pushBranch).not.toHaveBeenCalled();
  },
);

test("remote branch advancement is recovered immediately with current GitHub facts", async () => {
  policy("human");
  const advanced = { ...snapshot, headSha: "h3" };
  vi.mocked(steps.fetchPullRequestState).mockResolvedValue(advanced);
  answer(maintenanceReport, finished, () => {
    at("h3");
    return finished;
  });
  watch(snapshot, closed);
  await follow();
  expect(calls).toHaveLength(2);
  expect(calls[1]?.prompt).toContain('"headSha":"h3"');
  expect(calls[1]?.prompt).toContain("Local HEAD: h1. Published PR head: h3.");
});

test("dirty work is recovered immediately without waiting or another watcher yield", async () => {
  policy("human");
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
  watch(snapshot, closed);
  await follow();
  expect(calls).toHaveLength(2);
  expect(calls[1]?.prompt).toContain("dirty (uncommitted changes remain)");
  expect(sleep).not.toHaveBeenCalled();
});

test.each(["dirty", "unpublished"])(
  "persistent %s state exhausts only this update's allowance and preserves local work",
  async (kind) => {
    policy("human");
    at(kind === "dirty" ? "h1" : "h2", kind === "dirty");
    answer(maintenanceReport, finished, finished);
    watch(snapshot);
    const error = await stoppedMaintenance(
      follow({ ...delivery, budget: { ...delivery.budget, attemptsPerUpdate: 2 } }),
    );
    expect(calls).toHaveLength(2);
    expect(error.findings[0]).toContain("Exhausted 2 attempts for this pull request update");
    expect(error.findings[0]).toContain(`Local HEAD: ${head.headSha}`);
    expect(error.findings.at(-1)).toContain("without an automatic push");
  },
);

test("GitHub head lag resolves during bounded rechecks without another agent attempt", async () => {
  policy("human");
  at("h2");
  answer(maintenanceReport, finished);
  watch(snapshot, closed);
  vi.mocked(steps.fetchPullRequestState)
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({ ...snapshot, headSha: "h2" });
  await follow({ ...delivery, budget: { ...delivery.budget, attemptsPerUpdate: 1 } });
  expect(calls).toHaveLength(1);
  expect(sleep).toHaveBeenCalledTimes(2);
  expect(steps.fetchPullRequestState).toHaveBeenCalledTimes(3);
});

test.each([true, false])(
  "PR closure while rechecking mismatched heads is handled (merged=%s)",
  async (merged) => {
    policy("human");
    at("h2");
    answer(maintenanceReport, finished);
    watch(snapshot);
    vi.mocked(steps.fetchPullRequestState)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ ...closed, merged });
    if (merged) await follow();
    else await stoppedMaintenance(follow());
    expect(calls).toHaveLength(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  },
);

test("needs-human with mismatched local state stops without publishing or spending recovery attempts", async () => {
  policy("human");
  at("h2", true);
  answer(maintenanceReport, { status: "needs-human", summary: "Credentials unavailable." });
  watch(snapshot);
  const error = await stoppedMaintenance(follow());
  expect(error.findings[0]).toContain("Credentials unavailable");
  expect(calls).toHaveLength(1);
  expect(sleep).not.toHaveBeenCalled();
});

test("a fresh recovery prompt includes the same actionable facts when no session survives", async () => {
  policy("human");
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
  watch(snapshot, closed);
  await followPullRequest(delivery, pr, { harness: delivery.builder, run });
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
  policy("human");
  const recovered = { ...snapshot, headSha: "h2" };
  const changed = { ...recovered, labels: ["new-feedback"] };
  // Initial watch, turn read, two lag checks, recovery read, watch of the
  // already-assessed facts, new watch, turn read, then closure.
  const hook = await useRealWatcher([
    snapshot,
    recovered,
    recovered,
    recovered,
    recovered,
    recovered,
    changed,
    changed,
    closed,
  ]);
  answer(
    maintenanceReport,
    finished,
    () => {
      at("h2");
      return finished;
    },
    finished,
  );
  await follow();
  expect(calls).toHaveLength(3);
  expect(calls[1]?.prompt).toContain('"headSha":"h2"');
  expect(calls[1]?.prompt).toContain("Recovery required:");
  expect(calls[2]?.prompt).toContain("new-feedback");
  expect(hook.remaining).toHaveLength(0);
  expect(hook.wake).toHaveBeenCalledTimes(3);
  expect(hook.dispose).toHaveBeenCalledOnce();
});

test("real watcher still runs the builder for unseen facts first fetched after its turn", async () => {
  policy("human");
  const changed = { ...snapshot, labels: ["unseen-feedback"] };
  const hook = await useRealWatcher([snapshot, changed, changed, changed, closed]);
  answer(maintenanceReport, finished, finished);
  await follow();
  expect(calls).toHaveLength(2);
  expect(calls[0]?.prompt).not.toContain("unseen-feedback");
  expect(calls[1]?.prompt).toContain("unseen-feedback");
  expect(hook.remaining).toHaveLength(0);
  expect(hook.dispose).toHaveBeenCalledOnce();
});

test("maintenance failure note names the retained path once and directs takeover of the existing PR", async () => {
  policy("human");
  watch(snapshot);
  answer(maintenanceReport, { status: "needs-human", summary: "Please inspect the conflict." });
  const error = await stoppedMaintenance(follow());
  const note = error.note();
  const rendered = JSON.stringify(note);
  expect(rendered.split(worktree.path)).toHaveLength(2);
  expect(rendered).toContain(pr.url);
  expect(note.closing).toContain("existing pull request");
  expect(note.closing).toContain("take over");
  expect(note.closing).not.toContain("Start another run");
  expect(note.closing).not.toContain("resume");
});
