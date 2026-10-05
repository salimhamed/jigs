import { beforeEach, expect, test, vi } from "vitest";
import { createHook, sleep } from "workflow";
import { z } from "zod";
import { bindAgentSession } from "../agents/agent-session.ts";
import { type Harness, harnesses } from "../agents/harness-config.ts";
import { describeHarness } from "../agents/result.ts";
import { JigsError } from "../errors.ts";
import { postPullRequestNote } from "../pull-requests/answers.ts";
import { parseMarkers } from "../pull-requests/marker.ts";
import type { PullRequestSnapshot } from "../pull-requests/snapshot.ts";
import { watchPullRequest } from "../pull-requests/watch.ts";
import {
  formats,
  implementationReport,
  maintenanceReport,
  pullRequestDescription,
  reviewVerdict,
} from "./answers.ts";
import { bindDeliverySteps } from "./bind.ts";
import type { Delivery, DeliveryPrompts, DeliverySteps } from "./delivery.ts";
import type { FollowOptions, NeedsHuman } from "./follow.ts";
import { builderWakeFacts } from "./wake.ts";

const metadata = vi.hoisted(() => ({
  workflowRunId: "wrun_TEST",
  workflowName: "workflow//./workflows/linear-ticket-to-pr/linear-ticket-to-pr//linearTicketToPr",
}));
vi.mock("workflow", () => ({
  createHook: vi.fn(),
  sleep: vi.fn(async () => {}),
  getWorkflowMetadata: () => metadata,
}));
vi.mock("../pull-requests/watch.ts", () => ({ watchPullRequest: vi.fn() }));

const steps = {
  readBranchState: vi.fn(),
  readWorktreeDiff: vi.fn(async () => "diff --git a/x b/x"),
  pushApprovedChange: vi.fn(),
  createPullRequest: vi.fn(),
  registerResource: vi.fn(),
  fetchPullRequestState: vi.fn(),
  mergePullRequest: vi.fn(),
};
const commentOnPullRequest = vi.fn();
const { buildAndReview, describePullRequest, publishPullRequest, followPullRequestToOutcome } =
  bindDeliverySteps(steps as unknown as DeliverySteps);
const runAgent = vi.fn();
const agentSession = bindAgentSession(runAgent);

type Work = { brief: string };

// Prompts that show the facts they were given, so each test sees what reached the agent.
const prompts: DeliveryPrompts<Work> = {
  build: {
    fresh: ({ work, worktree, findings, diff }) =>
      `BUILD ${work.brief}\nBase commit: ${worktree.baseSha}\nCurrent diff:\n${diff}\n${JSON.stringify(findings)}`,
    resume: ({ findings }) => `BUILD AGAIN ${JSON.stringify(findings)}`,
  },
  review: {
    fresh: ({ work, headSha, diff, ledger }) =>
      `REVIEW ${work.brief} ${headSha}\n${diff}\n${JSON.stringify(ledger)}`,
    resume: ({ headSha, diff, responses }) =>
      `REVIEW AGAIN ${headSha}\n${diff}\n${JSON.stringify(responses)}`,
  },
  describe: ({ work, diff }) => `DESCRIBE ${work.brief}\n${diff}`,
  maintain: {
    fresh: ({ work, diff, pr, snapshot, news, recovery }) =>
      `MAINTAIN ${work.brief}\nCurrent diff:\n${diff}\n${JSON.stringify({ pr, snapshot, news, recovery })}`,
    resume: ({ pr, snapshot, news, recovery }) =>
      `MAINTAIN AGAIN ${JSON.stringify({ pr, snapshot, news, recovery })}`,
  },
};

const worktree = {
  binding: "app",
  path: "/tmp/wt",
  branch: "acme/abc-1",
  defaultBranch: "main",
  baseSha: "base",
};
const builderHarness = harnesses.codex({ model: "gpt-5.6-sol" });
const reviewerHarness = harnesses.claude({ model: "opus" });
const pr = { owner: "acme", repo: "app", number: 7, url: "https://github.com/acme/app/pull/7" };
const latestCommit = { approvalCovers: "latest-commit" };

const deliveryOf = (key: string, tree = worktree): Delivery<Work> => ({
  work: { brief: "THE TASK BRIEF" },
  key,
  worktree: tree,
  prompts,
  builder: agentSession({ name: `${key} builder`, harness: builderHarness, cwd: tree.path }),
  reviewer: agentSession({ name: `${key} reviewer`, harness: reviewerHarness, cwd: tree.path }),
});

type Call = { harness: Harness; prompt: string; resumed: boolean; output?: unknown };
let calls: Call[];
let answers: Map<unknown, unknown[]>;
let delivery: Delivery<Work>;
let options: FollowOptions;

// Answers are queued by output schema; a turn with no schema returns nothing.
function answer(schema: unknown, ...outputs: unknown[]) {
  answers.set(schema, [...(answers.get(schema) ?? []), ...outputs]);
}
let head: { headSha: string; dirty: boolean; commits: number };
const at = (headSha: string, dirty = false) => {
  head = { headSha, dirty, commits: 1 };
};
const onNeedsHuman = vi.fn(async (_facts: NeedsHuman) => {});
const notes = () => onNeedsHuman.mock.calls.map(([facts]) => facts);

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  answers = new Map();
  at("h1");
  delivery = deliveryOf("ABC-1");
  options = {
    attemptsPerUpdate: 3,
    wake: builderWakeFacts,
    mergeWhen: () => false,
    approvalCovers: "latest-commit",
    onNeedsHuman,
  };
  steps.fetchPullRequestState.mockResolvedValue(snapshot);
  runAgent.mockImplementation(
    async (request: { harness: Harness; prompt: string; resume?: unknown; output?: unknown }) => {
      calls.push({ ...request, resumed: request.resume !== undefined });
      const queued = answers.get(request.output)?.shift();
      const raw = typeof queued === "function" ? queued() : queued;
      // The real runAgent parses the answer with the caller's schema.
      const output = raw === undefined ? raw : (request.output as z.ZodType).parse(raw);
      const session = {
        harness: request.harness.kind,
        id: `s${calls.length}`,
        descriptor: describeHarness(request.harness),
      };
      return { output, session };
    },
  );
  steps.readBranchState.mockImplementation(async () => head);
});

function watch(...wakes: PullRequestSnapshot[]) {
  vi.mocked(watchPullRequest).mockImplementation(async function* () {
    yield* wakes;
  });
}
const mergesBy = (by: "jigs" | "human") => {
  options.mergeWhen = () => by === "jigs";
};
const follow = (overrides: Partial<FollowOptions> = {}) =>
  followPullRequestToOutcome(delivery, pr, { ...options, ...overrides });
const build = (rounds = 2) => buildAndReview(delivery, { rounds });

test("a blocking finding sends the round back, and the resumed builder is told only what is new", async () => {
  answer(implementationReport, { responses: [] }, { responses: [] });
  answer(
    reviewVerdict,
    { findings: [{ summary: "Missing test", blocking: true }] },
    { findings: [{ summary: "Rename x", blocking: false }] },
  );

  const built = await build();

  expect(built).toMatchObject({ outcome: "approved", reviewedCommit: "h1", notes: ["Rename x"] });
  if (built.outcome === "stopped") return expect.unreachable();
  expect(built.ledger.map((round) => round.verdict)).toEqual(["changes-requested", "approved"]);
  const [firstBuild, firstReview, secondBuild, secondReview] = calls;
  expect(firstBuild?.resumed).toBe(false);
  expect(firstBuild?.prompt).toContain("THE TASK BRIEF");
  expect(firstBuild?.prompt).toContain("Base commit: base");
  expect(firstBuild?.prompt).toContain("Current diff:\ndiff --git a/x b/x");
  expect(firstReview?.harness).toBe(reviewerHarness);
  expect(secondBuild?.resumed).toBe(true);
  expect(secondBuild?.prompt).toContain("Missing test");
  expect(secondBuild?.prompt).not.toContain("THE TASK BRIEF");
  expect(secondReview?.resumed).toBe(true);
  expect(secondReview?.prompt).not.toContain("THE TASK BRIEF");
});

test("every prompt ends with the answer format the engine parses", async () => {
  answer(implementationReport, { responses: [] });
  answer(reviewVerdict, { findings: [] });
  answer(pullRequestDescription, { title: "Add a flag", body: "Adds it." });
  answer(maintenanceReport, { needsHuman: false, summary: "Done." });
  watch(commented, closed);

  await build();
  await describePullRequest(delivery);
  await follow();

  const [built, reviewed, described, maintained] = calls.map((call) => call.prompt);
  expect(built).toMatch(/^BUILD .*\n\nReturn one response per finding/s);
  expect(built?.endsWith(formats.build)).toBe(true);
  expect(reviewed?.endsWith(formats.review)).toBe(true);
  expect(described?.endsWith(formats.describe)).toBe(true);
  expect(maintained?.endsWith(formats.maintain)).toBe(true);
});

test("exhausted rounds stop with the open findings and the last round, and push nothing", async () => {
  answer(implementationReport, { responses: [] }, { responses: [] });
  const blocked = {
    findings: [
      { summary: "Broken", blocking: true },
      { summary: "Rename x", blocking: false },
    ],
  };
  answer(reviewVerdict, blocked, blocked);

  await expect(build()).resolves.toEqual({
    outcome: "stopped",
    reason: "rounds-exhausted",
    findings: ["Broken"],
    round: 2,
  });
  expect(steps.pushApprovedChange).not.toHaveBeenCalled();
});

test("uncommitted work stops the delivery before any review", async () => {
  answer(implementationReport, { responses: [] });
  at("h1", true);

  await expect(build()).resolves.toEqual({
    outcome: "stopped",
    reason: "uncommitted",
    findings: [],
    round: 1,
  });
  expect(calls).toHaveLength(1);
});

test("a build round that commits nothing stops the delivery before any review", async () => {
  answer(implementationReport, { responses: [] });
  head = { headSha: "base", dirty: false, commits: 0 };

  await expect(build()).resolves.toEqual({
    outcome: "stopped",
    reason: "no-commits",
    findings: [],
    round: 1,
  });
  expect(steps.readBranchState).toHaveBeenCalledWith(worktree, "base");
  expect(calls).toHaveLength(1);
});

test("a stop after a reviewed round reports the round it stopped in", async () => {
  answer(implementationReport, { responses: [] }, () => {
    at("h2", true);
    return { responses: [] };
  });
  answer(reviewVerdict, { findings: [{ summary: "Broken", blocking: true }] });

  await expect(build(3)).resolves.toEqual({
    outcome: "stopped",
    reason: "uncommitted",
    findings: [],
    round: 2,
  });
});

test("a stopped delivery never puts the local worktree path in its findings", async () => {
  answer(implementationReport, { responses: [] }, { responses: [] });
  const blocked = { findings: [{ summary: "Broken in /tmp/wt/src/x.ts", blocking: true }] };
  answer(reviewVerdict, blocked, blocked);

  await expect(build()).resolves.toEqual({
    outcome: "stopped",
    reason: "rounds-exhausted",
    findings: ["Broken in the run's worktree/src/x.ts"],
    round: 2,
  });
});

test("the builder describes the diff when there is no writer", async () => {
  answer(pullRequestDescription, { title: "Add a flag", body: "Adds it." });

  await expect(describePullRequest(delivery)).resolves.toEqual({
    title: "Add a flag",
    body: "Adds it.",
  });
  expect(calls[0]?.harness).toBe(builderHarness);
  expect(calls[0]?.prompt).toContain("DESCRIBE THE TASK BRIEF\ndiff --git a/x b/x");
  expect(steps.pushApprovedChange).not.toHaveBeenCalled();
});

test("a writer session describes the change when there is one", async () => {
  answer(pullRequestDescription, { title: "Add a flag", body: "Adds it." });
  const writerHarness = harnesses.claude({ model: "sonnet" });
  const writer = agentSession({ name: "writer", harness: writerHarness, cwd: worktree.path });

  await describePullRequest({ ...delivery, writer });

  expect(calls.map((call) => call.harness)).toEqual([writerHarness]);
});

const conventional = ({ title }: { title: string }) =>
  /^(feat|fix): /.test(title) ? [] : ["The title must be a conventional commit."];

test("a check's problems send the writer back once, with the problems listed", async () => {
  answer(
    pullRequestDescription,
    { title: "Add a flag", body: "Adds it." },
    { title: "feat: add a flag", body: "Adds it." },
  );

  await expect(describePullRequest(delivery, { check: conventional })).resolves.toEqual({
    title: "feat: add a flag",
    body: "Adds it.",
  });
  expect(calls).toHaveLength(2);
  expect(calls[1]?.resumed).toBe(true);
  expect(calls[1]?.prompt).toContain("- The title must be a conventional commit.");
  expect(calls[1]?.prompt.endsWith(formats.describe)).toBe(true);
});

test("a fresh writer sent back is shown the rejected title and body with the problems", async () => {
  const fresh: string[] = [];
  const run = vi.fn(async (turn: { fresh: string }) => {
    fresh.push(turn.fresh);
    return fresh.length === 1
      ? { title: "Add a flag", body: "Adds it." }
      : { title: "feat: add a flag", body: "Adds it." };
  });
  const writer = { harness: builderHarness, run } as unknown as Delivery<Work>["builder"];

  await describePullRequest({ ...delivery, writer }, { check: conventional });

  expect(fresh[1]).toContain("DESCRIBE THE TASK BRIEF");
  expect(fresh[1]).toContain("Title: Add a flag");
  expect(fresh[1]).toContain("- The title must be a conventional commit.");
});

test("a second answer that still fails the check throws, naming the problems", async () => {
  const plain = { title: "Add a flag", body: "Adds it." };
  answer(pullRequestDescription, plain, plain);

  const described = describePullRequest(delivery, { check: conventional });

  await expect(described).rejects.toBeInstanceOf(JigsError);
  await expect(described).rejects.toThrow("The title must be a conventional commit.");
  expect(calls).toHaveLength(2);
});

test("publish pushes exactly the given commit and opens the pull request with the given title and body, running no agent", async () => {
  steps.createPullRequest.mockResolvedValue(pr);

  const opened = await publishPullRequest(delivery, {
    commit: "h1",
    title: "feat: add a flag",
    body: "Adds it.",
    draft: true,
  });

  expect(opened).toBe(pr);
  expect(calls).toHaveLength(0);
  expect(steps.pushApprovedChange).toHaveBeenCalledWith(worktree, "h1");
  expect(steps.createPullRequest).toHaveBeenCalledWith({
    worktree,
    title: "feat: add a flag",
    body: "Adds it.",
    draft: true,
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
])("the description schema rejects %s", (_, title) => {
  expect(pullRequestDescription.safeParse({ title, body: "Adds it." }).success).toBe(false);
});

test.each([
  "#123 follow-up",
  "*.env files are ignored",
  "title: truncate long titles",
  "Tidy ".repeat(30),
])("the description schema accepts the title %s", (title) => {
  expect(pullRequestDescription.safeParse({ title, body: "Adds it." }).success).toBe(true);
});

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

test("a description the schema rejects throws from describePullRequest", async () => {
  answer(pullRequestDescription, { title: "Title: Add a flag", body: "Adds it." });

  await expect(describePullRequest(delivery)).rejects.toBeInstanceOf(z.ZodError);
});

const snapshot: PullRequestSnapshot = {
  appBot: "jigs[bot]",
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
const finished = { needsHuman: false, summary: "All requests addressed." };

test("the implementation builder resumes to judge the PR and merges only after GitHub readiness", async () => {
  mergesBy("jigs");
  answer(implementationReport, { responses: [] });
  answer(reviewVerdict, { findings: [] });
  answer(maintenanceReport, finished);
  watch(commented);
  steps.fetchPullRequestState.mockResolvedValue(commented);
  steps.mergePullRequest.mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  await build();
  await expect(follow()).resolves.toEqual({ outcome: "merged" });
  expect(calls[2]?.harness).toBe(builderHarness);
  expect(calls[2]?.resumed).toBe(true);
  expect(calls[2]?.prompt).not.toContain("THE TASK BRIEF");
  expect(steps.mergePullRequest).toHaveBeenCalledWith(pr, "h1", latestCommit);
});

test("an unavailable session gets the task, local diff and PR facts in a fresh prompt", async () => {
  answer(maintenanceReport, finished);
  watch(commented, closed);
  await follow();
  expect(calls[0]?.prompt).toContain("THE TASK BRIEF");
  expect(calls[0]?.prompt).toContain("Current diff:");
  expect(calls[0]?.prompt).toContain('"number":7');
  expect(calls[0]?.prompt).toContain('"snapshot":');
});

test("attempt allowance resets for every update and permits more than six updates", async () => {
  const updates = Array.from({ length: 8 }, (_, i) => withComment(snapshot, i));
  answer(maintenanceReport, ...updates.map(() => finished));
  watch(...updates, closed);
  await follow({ attemptsPerUpdate: 1 });
  expect(calls).toHaveLength(8);
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("a human merger means jigs never merges", async () => {
  answer(maintenanceReport, finished);
  watch(snapshot, commented, closed);
  await expect(follow()).resolves.toEqual({ outcome: "merged" });
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("closed snapshots run no agent and closing without merging returns closed without a push", async () => {
  watch({ ...closed, merged: false });
  await expect(follow()).resolves.toEqual({ outcome: "closed" });
  expect(calls).toHaveLength(0);
});

test("CI moving from none through pending to green wakes no builder", async () => {
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
  steps.mergePullRequest.mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  watch(opened, { ...opened, ci: "pending" }, { ...unapproved, ci: "green" }, snapshot);
  await follow();
  expect(calls).toHaveLength(0);
  expect(steps.mergePullRequest).toHaveBeenCalledOnce();
  expect(steps.mergePullRequest).toHaveBeenCalledWith(pr, "h1", latestCommit);
});

test("a newly failed check wakes the builder once; the same failure on the same head does not", async () => {
  answer(maintenanceReport, { needsHuman: false, summary: "Waiting for a re-run." });
  const red = failed(opened, "build");
  steps.fetchPullRequestState.mockResolvedValue(red);
  const rerun = failed(opened, "build");
  watch(opened, red, { ...opened, ci: "pending" }, { ...rerun, mergeState: "blocked" }, closed);
  await follow();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.prompt).toContain('"name":"build"');
});

test("a conflict with the base wakes the builder", async () => {
  answer(maintenanceReport, finished);
  watch({ ...opened, mergeState: "dirty" }, closed);
  await follow();
  expect(calls).toHaveLength(1);
});

test("needs-human calls back with the builder's summary and keeps watching; a later approval on a green head merges", async () => {
  mergesBy("jigs");
  answer(maintenanceReport, {
    needsHuman: true,
    summary: "The CodeBuild check needs a re-run.",
  });
  const waiting = withComment({ ...unapproved, ci: "pending" });
  steps.fetchPullRequestState.mockResolvedValue(waiting);
  steps.mergePullRequest.mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  watch(waiting, { ...waiting, ci: "green" }, withComment(snapshot));
  await follow();
  expect(calls).toHaveLength(1);
  expect(notes()).toEqual([
    { reason: "builder-asked", detail: "The CodeBuild check needs a re-run." },
  ]);
  expect(steps.mergePullRequest).toHaveBeenCalledOnce();
});

test.each([false, true])(
  "a report with needsHuman %s does not hold back a merge a person approved on a green head",
  async (needsHuman) => {
    mergesBy("jigs");
    answer(maintenanceReport, { needsHuman, summary: "Waiting for a decision." });
    steps.fetchPullRequestState.mockResolvedValue(commented);
    steps.mergePullRequest.mockResolvedValue({ merged: true, mergeCommitSha: "m" });
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
    steps.fetchPullRequestState.mockResolvedValue(state);
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
  steps.fetchPullRequestState.mockResolvedValue({ ...commented, headSha: "h2" });
  await follow();
  expect(calls).toHaveLength(1);
  expect(sleep).not.toHaveBeenCalled();
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("an approved green PR GitHub blocks needs a person once per head; a marked note wakes no builder", async () => {
  mergesBy("jigs");
  const posted: string[] = [];
  commentOnPullRequest.mockImplementation(async (_pr: unknown, body: string) => {
    posted.push(body);
    return { id: 100 + posted.length };
  });
  // GitHub as it stands: the head, and every note jigs has posted so far.
  let headSha = "h1";
  const blocked = (): PullRequestSnapshot => ({
    ...snapshot,
    headSha,
    mergeState: "blocked",
    reviews: snapshot.reviews.map((review) => ({ ...review, commitSha: headSha })),
    conversationComments: posted.map((body, i) => ({ ...comment(100 + i, body), userType: "Bot" })),
  });
  steps.fetchPullRequestState.mockImplementation(async () => blocked());
  vi.mocked(watchPullRequest).mockImplementation(async function* () {
    yield blocked();
    yield blocked();
    headSha = "h2";
    yield blocked();
    yield blocked();
    yield closed;
  });
  const scope = "linearTicketToPr/ABC-1";
  onNeedsHuman.mockImplementation(async (facts) => {
    if (facts.reason !== "merge-blocked") return;
    await postPullRequestNote({
      pr,
      scope,
      headSha: facts.headSha,
      reason: "merge-retry",
      body: facts.detail,
      fetchPullRequestState: steps.fetchPullRequestState,
      commentOnPullRequest,
    });
  });

  await follow();

  expect(calls).toHaveLength(0);
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
  expect(notes()).toEqual(
    ["h1", "h2"].map((headSha) => ({
      reason: "merge-blocked",
      headSha,
      detail: expect.stringMatching(/approved and CI is green.*keeps watching/s),
    })),
  );
  expect(posted.flatMap(parseMarkers)).toEqual(
    ["h1", "h2"].map((source) =>
      expect.objectContaining({ scope, kind: "status", reason: "merge-retry", source }),
    ),
  );
  onNeedsHuman.mockImplementation(async () => {});
});

test("a blocked merge is reported once per head, even with another need in between", async () => {
  mergesBy("jigs");
  const blocked = { ...snapshot, mergeState: "blocked" as const };
  answer(maintenanceReport, { needsHuman: true, summary: "Stuck." });
  steps.fetchPullRequestState.mockResolvedValue(withComment(blocked));
  watch(blocked, withComment(blocked), closed);

  await follow();

  expect(notes().map((facts) => facts.reason)).toEqual(["merge-blocked", "builder-asked"]);
});

test("a no from mergeWhen while polling after a refusal keeps polling", async () => {
  const ship = { ...snapshot, labels: ["ship"] };
  steps.mergePullRequest
    .mockResolvedValueOnce({ merged: false, reason: "computing", transient: true })
    .mockResolvedValueOnce({ merged: true, mergeCommitSha: "m" });
  steps.fetchPullRequestState.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(ship);
  watch(ship);

  await expect(follow({ mergeWhen: (state) => state.labels.includes("ship") })).resolves.toEqual({
    outcome: "merged",
  });

  expect(steps.mergePullRequest).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledTimes(2);
});

test("a blocked merge is not reported when the workflow does not consent to merging", async () => {
  watch({ ...snapshot, mergeState: "blocked" }, closed);
  await follow();
  expect(notes()).toEqual([]);
});

test("mergeWhen is asked about the current snapshot, and its yes still waits for readiness", async () => {
  const labelled = (state: PullRequestSnapshot) => ({ ...state, labels: ["ship-it"] });
  const mergeWhen = vi.fn((state: PullRequestSnapshot) => state.labels.includes("ship-it"));
  steps.mergePullRequest.mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  watch(snapshot, labelled(unapproved), labelled(snapshot));

  await follow({ mergeWhen });

  expect(mergeWhen.mock.calls.map(([state]) => state.labels)).toEqual([
    [],
    ["ship-it"],
    ["ship-it"],
  ]);
  expect(steps.mergePullRequest).toHaveBeenCalledOnce();
});

test("a custom wake rule decides what wakes the builder", async () => {
  const fromBot = { ...comment(9, "Coverage: 91%"), user: "codecov[bot]", userType: "Bot" };
  const wake = (state: PullRequestSnapshot, scope: string) =>
    builderWakeFacts(
      {
        ...state,
        conversationComments: state.conversationComments.filter((c) => c.user !== "codecov[bot]"),
      },
      scope,
    );
  answer(maintenanceReport, finished);
  watch({ ...opened, conversationComments: [fromBot] }, withComment(opened), closed);

  await follow({ wake });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.prompt).toContain("Please rename x.");
});

test("the builder is told which wake facts are new, and a recovery turn alone carries none", async () => {
  answer(maintenanceReport, finished, finished, () => {
    at("h1");
    return finished;
  });
  const second = withComment(commented, 2, "One more thing.");
  steps.fetchPullRequestState.mockResolvedValueOnce(commented).mockResolvedValue(second);
  vi.mocked(watchPullRequest).mockImplementation(async function* () {
    yield commented;
    yield second;
    at("h1", true);
    yield { ...second, labels: ["later"] };
    yield closed;
  });

  await follow();

  const news = calls.map((call) => call.prompt.match(/"news":(\[[^\]]*\])/)?.[1]);
  expect(news).toEqual(['["comment:1:2026-01-01"]', '["comment:2:2026-01-01"]', "[]"]);
  expect(calls[2]?.prompt).toContain('"recovery":{"dirty":true');
});

test("a person's comment posted during the builder's turn wakes it afterwards", async () => {
  answer(maintenanceReport, finished, finished);
  const during = withComment(commented, 2, "One more thing.");
  steps.fetchPullRequestState.mockResolvedValue(during);
  watch(commented, during, closed);
  await follow();
  expect(calls).toHaveLength(2);
});

test("a check failing during the builder's turn is not mistaken for its own and wakes it", async () => {
  answer(maintenanceReport, finished, finished);
  const red = failed(commented, "build");
  steps.fetchPullRequestState.mockResolvedValueOnce(red).mockResolvedValue(red);
  watch(commented, red, closed);
  await follow();
  expect(calls).toHaveLength(2);
});

test("a transient merge refusal is retried after a durable wait, without a new watcher yield", async () => {
  mergesBy("jigs");
  steps.mergePullRequest
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
  steps.mergePullRequest
    .mockRejectedValueOnce(new Error("GitHub 502"))
    .mockResolvedValueOnce({ merged: true, mergeCommitSha: "m" });
  watch(snapshot);
  await follow();
  expect(steps.mergePullRequest).toHaveBeenCalledTimes(2);
});

test("a merge state GitHub is still computing is polled until it reads clean", async () => {
  mergesBy("jigs");
  steps.mergePullRequest
    .mockResolvedValueOnce({ merged: false, reason: "computing", transient: true })
    .mockResolvedValueOnce({ merged: true, mergeCommitSha: "m" });
  steps.fetchPullRequestState
    .mockResolvedValueOnce({ ...snapshot, mergeState: "unknown" })
    .mockResolvedValueOnce(snapshot);
  watch(snapshot);
  await follow();
  expect(steps.mergePullRequest).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledTimes(2);
});

test("after a transient refusal, a not-ready read that settles back to the yielded state still merges", async () => {
  mergesBy("jigs");
  steps.mergePullRequest
    .mockResolvedValueOnce({ merged: false, reason: "CI is pending", transient: true })
    .mockResolvedValueOnce({ merged: true, mergeCommitSha: "m" });
  steps.fetchPullRequestState
    .mockResolvedValueOnce({ ...snapshot, mergeState: "blocked", ci: "pending" })
    .mockResolvedValueOnce(snapshot);
  watch(snapshot);
  await follow();
  expect(steps.mergePullRequest).toHaveBeenCalledTimes(2);
  expect(notes()).toEqual([]);
});

test("merge retries give up after ten tries with one call back, then watching goes on", async () => {
  mergesBy("jigs");
  steps.mergePullRequest.mockRejectedValue(new Error("GitHub 502"));
  watch(snapshot, closed);
  await follow();
  expect(steps.mergePullRequest).toHaveBeenCalledTimes(10);
  expect(sleep).toHaveBeenCalledTimes(9);
  expect(notes()).toEqual([{ reason: "merge-refused", detail: "Error: GitHub 502", tries: 10 }]);
});

test("a merge refused for a reason no wake changes is reported once", async () => {
  mergesBy("jigs");
  steps.mergePullRequest.mockResolvedValue({
    merged: false,
    reason: "merge method disabled",
    transient: false,
  });
  watch(snapshot, { ...snapshot, labels: ["a"] }, closed);
  await follow();
  expect(steps.mergePullRequest).toHaveBeenCalledTimes(2);
  expect(sleep).not.toHaveBeenCalled();
  expect(notes()).toEqual([{ reason: "merge-refused", detail: "merge method disabled", tries: 1 }]);
});

test("the same needs-human facts are not sent twice in a row", async () => {
  const stuck = { needsHuman: true, summary: "A person must re-run CodeBuild." };
  answer(maintenanceReport, stuck, stuck);
  watch(commented, withComment(commented, 2), closed);
  steps.fetchPullRequestState
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
    steps.fetchPullRequestState.mockResolvedValue(commented);
    watch(commented, { ...commented, labels: ["later"] }, closed);
    await follow({ attemptsPerUpdate: 2 });
    expect(calls).toHaveLength(2);
    expect(notes()).toHaveLength(1);
    expect(steps.mergePullRequest).not.toHaveBeenCalled();
  },
);

test("a person pushing past local work that is on the PR does not hold back a merge", async () => {
  mergesBy("jigs");
  steps.mergePullRequest.mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  const pushed = {
    ...snapshot,
    headSha: "h3",
    reviews: snapshot.reviews.map((review) => ({ ...review, commitSha: "h3" })),
  };
  watch(unapproved, pushed);
  await follow();
  expect(calls).toHaveLength(0);
  expect(steps.mergePullRequest).toHaveBeenCalledWith(pr, "h3", latestCommit);
});

test("local commits that never reached the PR still hold back a merge after a person pushes", async () => {
  mergesBy("jigs");
  at("h2");
  answer(maintenanceReport, finished);
  steps.fetchPullRequestState.mockResolvedValue(commented);
  const pushed = {
    ...commented,
    headSha: "h3",
    reviews: commented.reviews.map((review) => ({ ...review, commitSha: "h3" })),
  };
  watch(commented, pushed, closed);
  await follow({ attemptsPerUpdate: 1 });
  expect(calls).toHaveLength(1);
  expect(notes()).toEqual([
    {
      reason: "attempts-exhausted",
      detail: finished.summary,
      unpublished: { dirty: false, localHead: "h2", pullRequestHead: "h1" },
    },
  ]);
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("a dirty worktree is recovered on the first yield with no wake fact, and never merged over", async () => {
  mergesBy("jigs");
  at("h1", true);
  answer(maintenanceReport, finished);
  watch(snapshot, closed);
  await follow({ attemptsPerUpdate: 1 });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.prompt).toContain('"recovery":{"dirty":true');
  expect(notes()).toHaveLength(1);
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("a worktree edited while parked is recovered on the next yield", async () => {
  answer(maintenanceReport, finished, () => {
    at("h1");
    return finished;
  });
  vi.mocked(watchPullRequest).mockImplementation(async function* () {
    yield commented;
    at("h1", true);
    yield { ...commented, labels: ["later"] };
    yield closed;
  });
  await follow();
  expect(calls).toHaveLength(2);
  expect(calls[1]?.prompt).toContain('"recovery":{"dirty":true');
});

test("local state is read again right before merging", async () => {
  mergesBy("jigs");
  steps.readBranchState
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
  steps.fetchPullRequestState.mockResolvedValue(requested);
  steps.mergePullRequest.mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  watch(commented, requested);
  await follow();
  expect(calls).toHaveLength(2);
  expect(steps.mergePullRequest.mock.invocationCallOrder[0]).toBeGreaterThan(
    runAgent.mock.invocationCallOrder[1] ?? Infinity,
  );
});

test("needs-human over unpublished local work says what holds back the merge", async () => {
  mergesBy("jigs");
  at("h1", true);
  answer(maintenanceReport, { needsHuman: true, summary: "Stuck." });
  watch(commented, closed);
  await follow();
  expect(notes()[0]).toMatchObject({
    reason: "builder-asked",
    unpublished: { dirty: true, localHead: "h1", pullRequestHead: "h1" },
  });
  expect(steps.mergePullRequest).not.toHaveBeenCalled();
});

test("once the retained work is published, a ready PR merges again", async () => {
  mergesBy("jigs");
  at("h1", true);
  answer(maintenanceReport, finished);
  steps.fetchPullRequestState.mockResolvedValue(commented);
  steps.mergePullRequest.mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  const published = {
    ...commented,
    headSha: "h2",
    reviews: commented.reviews.map((review) => ({ ...review, commitSha: "h2" })),
  };
  vi.mocked(watchPullRequest).mockImplementation(async function* () {
    yield commented;
    at("h2");
    yield published;
  });
  await follow({ attemptsPerUpdate: 1 });
  expect(steps.mergePullRequest).toHaveBeenCalledWith(pr, "h2", latestCommit);
});

test("reordered GitHub collections do not prevent a ready merge", async () => {
  mergesBy("jigs");
  answer(maintenanceReport, finished);
  const state = { ...commented, labels: ["one", "two"] };
  watch(state);
  steps.fetchPullRequestState.mockResolvedValue({ ...state, labels: ["two", "one"] });
  steps.mergePullRequest.mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  await follow();
  expect(steps.mergePullRequest).toHaveBeenCalledOnce();
});

test.each(["jigs", "human"] as const)(
  "a forgotten push recovers immediately in %s mode without another watcher yield",
  async (by) => {
    mergesBy(by);
    let published = "h1";
    steps.fetchPullRequestState.mockImplementation(async () => ({
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
    expect(calls[1]?.prompt).toContain(
      '"recovery":{"dirty":false,"localHead":"h2","pullRequestHead":"h1"}',
    );
    expect(sleep).toHaveBeenCalledTimes(2);
  },
);

test("a person pushing ahead of the builder is not a recovery reason", async () => {
  steps.fetchPullRequestState.mockResolvedValue({ ...commented, headSha: "h3" });
  answer(maintenanceReport, finished);
  watch(commented, closed);
  await follow();
  expect(calls).toHaveLength(1);
});

test("dirty work is recovered immediately without waiting or another watcher yield", async () => {
  answer(
    maintenanceReport,
    () => {
      at("h1", true);
      return { needsHuman: false, summary: "Not committed yet." };
    },
    () => {
      at("h1");
      return finished;
    },
  );
  watch(commented, closed);
  await follow();
  expect(calls).toHaveLength(2);
  expect(calls[1]?.prompt).toContain('"recovery":{"dirty":true');
  expect(sleep).not.toHaveBeenCalled();
});

test.each(["dirty", "unpublished"])(
  "persistent %s state exhausts only this update's allowance, calls back and keeps watching",
  async (kind) => {
    at(kind === "dirty" ? "h1" : "h2", kind === "dirty");
    answer(maintenanceReport, finished, finished);
    watch(commented, closed);
    await follow({ attemptsPerUpdate: 2 });
    expect(calls).toHaveLength(2);
    expect(notes()).toEqual([
      {
        reason: "attempts-exhausted",
        detail: finished.summary,
        unpublished: { dirty: head.dirty, localHead: head.headSha, pullRequestHead: "h1" },
      },
    ]);
  },
);

test("GitHub head lag resolves during bounded rechecks without another agent attempt", async () => {
  at("h2");
  answer(maintenanceReport, finished);
  watch(commented, closed);
  steps.fetchPullRequestState
    .mockResolvedValueOnce(commented)
    .mockResolvedValueOnce(commented)
    .mockResolvedValueOnce({ ...commented, headSha: "h2" });
  await follow({ attemptsPerUpdate: 1 });
  expect(calls).toHaveLength(1);
  expect(sleep).toHaveBeenCalledTimes(2);
  expect(steps.fetchPullRequestState).toHaveBeenCalledTimes(3);
});

test.each([true, false])(
  "PR closure while rechecking mismatched heads is handled (merged=%s)",
  async (merged) => {
    at("h2");
    answer(maintenanceReport, finished);
    watch(commented);
    steps.fetchPullRequestState
      .mockResolvedValueOnce(commented)
      .mockResolvedValueOnce({ ...closed, merged });
    await expect(follow()).resolves.toEqual({ outcome: merged ? "merged" : "closed" });
    expect(calls).toHaveLength(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  },
);

test("needs-human with mismatched local state calls back without spending recovery attempts", async () => {
  at("h2", true);
  answer(maintenanceReport, { needsHuman: true, summary: "Credentials unavailable." });
  watch(commented, closed);
  await follow();
  expect(notes()[0]?.detail).toBe("Credentials unavailable.");
  expect(calls).toHaveLength(1);
  expect(sleep).not.toHaveBeenCalled();
});

test("a fresh recovery prompt includes the same actionable facts when no session survives", async () => {
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
      expect(prompt).toContain('"recovery":{"dirty":true');
      at("h1");
      return finished;
    });
  delivery.builder = { harness: builderHarness, run };
  watch(commented, closed);
  await follow();
  expect(run).toHaveBeenCalledTimes(2);
});

async function useRealWatcher(states: PullRequestSnapshot[]) {
  const actual = await vi.importActual<typeof import("../pull-requests/watch.ts")>(
    "../pull-requests/watch.ts",
  );
  vi.mocked(watchPullRequest).mockImplementation(actual.watchPullRequest);
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
  steps.fetchPullRequestState.mockImplementation(async () => {
    const state = remaining.shift();
    if (state === undefined) throw new Error("Unexpected extra PR read");
    return state;
  });
  return { dispose, wake, remaining };
}

test("real watcher does not repeat facts already assessed during recovery but delivers genuinely new facts", async () => {
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
  expect(calls[1]?.prompt).toContain(
    '"recovery":{"dirty":false,"localHead":"h2","pullRequestHead":"h1"}',
  );
  expect(calls[2]?.prompt).toContain("new-feedback");
  expect(hook.remaining).toHaveLength(0);
  expect(hook.wake).toHaveBeenCalledTimes(3);
  expect(hook.dispose).toHaveBeenCalledOnce();
});

test("real watcher still runs the builder for unseen facts first fetched after its turn", async () => {
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

test("needs-human facts never carry the local worktree path", async () => {
  watch(commented, closed);
  answer(maintenanceReport, { needsHuman: true, summary: "Look at /tmp/wt/src/x.ts." });
  await follow();
  expect(notes()).toEqual([
    { reason: "builder-asked", detail: "Look at the run's worktree/src/x.ts." },
  ]);
});

test("every pull request read and the merge count approvals as the workflow chose", async () => {
  mergesBy("jigs");
  answer(maintenanceReport, finished);
  watch(commented);
  steps.mergePullRequest.mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  await follow({ approvalCovers: "any-commit" });
  const covers = { approvalCovers: "any-commit" };
  expect(watchPullRequest).toHaveBeenCalledWith(pr, steps.fetchPullRequestState, covers);
  expect(steps.fetchPullRequestState).toHaveBeenCalledWith(pr, covers);
  expect(steps.mergePullRequest).toHaveBeenCalledWith(pr, "h1", covers);
});

test("under any-commit, a builder push after an approval merges without asking anyone", async () => {
  mergesBy("jigs");
  // The approval names h1; read with any-commit, it still covers h2.
  const pushed = { ...snapshot, headSha: "h2" };
  answer(maintenanceReport, () => {
    at("h2");
    return finished;
  });
  steps.fetchPullRequestState.mockResolvedValue(pushed);
  steps.mergePullRequest.mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  watch(commented, pushed);
  await follow({ approvalCovers: "any-commit" });
  expect(notes()).toHaveLength(0);
  expect(steps.mergePullRequest).toHaveBeenCalledOnce();
  expect(steps.mergePullRequest).toHaveBeenCalledWith(pr, "h2", {
    approvalCovers: "any-commit",
  });
});

test("two deliveries in one run, with their own keys, each go from build to merge", async () => {
  mergesBy("jigs");
  const api = deliveryOf("API-1", { ...worktree, binding: "api", path: "/tmp/api" });
  const web = deliveryOf("WEB-1", { ...worktree, binding: "web", path: "/tmp/web" });
  answer(implementationReport, { responses: [] }, { responses: [] });
  answer(reviewVerdict, { findings: [] }, { findings: [] });
  answer(
    pullRequestDescription,
    { title: "API change", body: "Adds it." },
    { title: "Web change", body: "Uses it." },
  );
  const prs = { "/tmp/api": { ...pr, repo: "api" }, "/tmp/web": { ...pr, repo: "web" } };
  steps.createPullRequest.mockImplementation(
    async ({ worktree }: { worktree: { path: keyof typeof prs } }) => prs[worktree.path],
  );
  steps.mergePullRequest.mockResolvedValue({ merged: true, mergeCommitSha: "m" });
  watch(snapshot);

  const outcomes = [];
  for (const each of [api, web]) {
    const built = await buildAndReview(each, { rounds: 1 });
    if (built.outcome === "stopped") return expect.unreachable();
    const described = await describePullRequest(each);
    const opened = await publishPullRequest(each, { commit: built.reviewedCommit, ...described });
    outcomes.push(await followPullRequestToOutcome(each, opened, options));
  }

  expect(outcomes).toEqual([{ outcome: "merged" }, { outcome: "merged" }]);
  expect(steps.mergePullRequest.mock.calls.map(([merged]) => merged.repo)).toEqual(["api", "web"]);
});

test("two deliveries with the same key in different worktrees both run", async () => {
  answer(implementationReport, { responses: [] }, { responses: [] });
  answer(reviewVerdict, { findings: [] }, { findings: [] });

  const elsewhere = deliveryOf("ABC-1", { ...worktree, path: "/tmp/other" });
  await expect(build()).resolves.toMatchObject({ reviewedCommit: "h1" });
  await expect(buildAndReview(elsewhere, { rounds: 1 })).resolves.toMatchObject({
    reviewedCommit: "h1",
  });
  expect(calls).toHaveLength(4);
});
