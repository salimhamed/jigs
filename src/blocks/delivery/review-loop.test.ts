import { describe, expect, it, vi } from "vitest";
import type { AgentFn } from "../agent/resume-or-rebuild.ts";
import { resumeFailed } from "../agent/resume-or-rebuild.ts";
import type { GateAck, GateWake } from "../pull-request/gate.ts";
import { bindDeliverySteps } from "./review-loop.ts";
import type { ApprovedChange, DeliverySteps, ReviewLoopOptions } from "./types.ts";

const pr = { owner: "owner", repo: "repo", number: 1 };
const options: ReviewLoopOptions = {
  task: { key: "internal-42", title: "Repair search", instructions: "Find exact matches" },
  worktree: { path: "/work", branch: "fix", defaultBranch: "main", baseSha: "base" },
  binding: "repo",
  implementation: { harness: { kind: "codex", model: "builder" } },
  review: { harness: { kind: "claude", model: "reviewer" } },
  limits: { implementationReviewRounds: 2, ciFixAttempts: 1, pullRequestRevisionRounds: 1 },
  merge: "human",
};

function setup(wakes: GateWake[] = [{ kind: "closed", merged: true }]) {
  const calls: Array<{
    harness: { kind: string; model: string };
    prompt: string;
    resume?: unknown;
  }> = [];
  const agent: AgentFn = async <T>(config: Parameters<AgentFn>[0]) => {
    calls.push(config);
    const output = config.output?.parse(
      config.prompt.includes("Review the changes")
        ? { verdict: "approved", findings: [] }
        : config.prompt.includes("Write a concise")
          ? { title: "fix: search", body: "Fixed and tested" }
          : { answers: [{ threadId: null, body: "Done" }] },
    ) as T;
    return { text: "", output, session: { harness: config.harness.kind, id: "session" } };
  };
  const acks: Array<GateAck | undefined> = [];
  const closed = vi.fn();
  async function* gate(): AsyncGenerator<GateWake, void, GateAck | undefined> {
    try {
      for (const wake of wakes) acks.push(yield wake);
    } finally {
      closed();
    }
  }
  const steps: DeliverySteps = {
    agent,
    pullRequestGate: gate,
    readBranchState: vi.fn().mockResolvedValue({ commits: 1, headSha: "new", dirty: false }),
    readWorktreeDiff: vi.fn().mockResolvedValue("diff"),
    pushBranch: vi.fn().mockResolvedValue({ headSha: "new" }),
    resolveRepository: vi.fn().mockResolvedValue({ owner: "owner", repo: "repo" }),
    createPullRequest: vi.fn().mockResolvedValue(pr),
    commentOnPullRequest: vi.fn().mockResolvedValue(undefined),
    replyToPullRequestReviewThread: vi.fn().mockResolvedValue({ id: 77 }),
    squashMergePullRequest: vi.fn().mockResolvedValue({ merged: true, sha: "merged" }),
  };
  return { steps, calls, acks, closed };
}

const approved: ApprovedChange = {
  task: options.task,
  worktree: options.worktree,
  attempts: { implementationReviewRounds: 1, ciFixAttempts: 0, pullRequestRevisionRounds: 0 },
  sessions: {},
  approval: { reviewedCommit: "new" },
};

const publish = { change: approved, binding: "repo", implementation: options.implementation };

const red = (headSha: string): GateWake => ({
  kind: "ci-red",
  headSha,
  failing: [],
  mentionLogin: null,
});

describe("delivery", () => {
  it("delivers a provider-independent task with separate roles and retains worktree facts", async () => {
    const { steps, calls, closed } = setup();
    const result = await bindDeliverySteps(steps).reviewLoop(options);
    expect(result.status).toBe("merged");
    expect(result.change.worktree).toEqual(options.worktree);
    expect(calls.map((call) => call.harness.model)).toEqual(["builder", "reviewer", "builder"]);
    expect(calls[1]?.resume).toBeUndefined();
    expect(calls[2]?.resume).toBeUndefined();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("returns limit-reached without opening a PR or implicitly retrying", async () => {
    const { steps } = setup();
    const agent = vi.fn().mockImplementation(async (config) => ({
      text: "",
      output: config.output
        ? { verdict: "changes-requested", findings: ["Missing test"] }
        : undefined,
    }));
    steps.agent = agent;
    const result = await bindDeliverySteps(steps).reviewLoop(options);
    expect(result).toMatchObject({
      status: "limit-reached",
      phase: "implementation-review",
      attempts: 2,
    });
    expect(agent).toHaveBeenCalledTimes(4);
    expect(steps.createPullRequest).not.toHaveBeenCalled();
  });

  it("only adds the explicitly granted attempts and passes human direction", async () => {
    const { steps } = setup();
    const prompts: string[] = [];
    steps.agent = (async (config) => {
      prompts.push(config.prompt);
      return {
        text: "",
        output: config.output ? { verdict: "changes-requested", findings: ["Test"] } : undefined,
      };
    }) as AgentFn;
    const onLimit = vi
      .fn()
      .mockResolvedValueOnce({
        action: "continue",
        additionalAttempts: 1,
        instructions: "Test Unicode",
      })
      .mockResolvedValueOnce({ action: "stop" });
    const result = await bindDeliverySteps(steps).reviewLoop({ ...options, onLimit });
    expect(result).toMatchObject({ status: "stopped", attempts: 3 });
    expect(prompts[4]).toContain("Test Unicode");
    expect(onLimit).toHaveBeenCalledTimes(2);
  });

  it("counts CI repairs cumulatively across green checks and ignores duplicate red wakes", async () => {
    const { steps, calls, closed } = setup([
      red("first"),
      red("first"),
      { kind: "ci-green", headSha: "second" },
      red("second"),
    ]);
    vi.mocked(steps.readBranchState)
      .mockResolvedValueOnce({ commits: 1, headSha: "new", dirty: false })
      .mockResolvedValueOnce({ commits: 1, headSha: "new", dirty: false })
      .mockResolvedValueOnce({ commits: 1, headSha: "first", dirty: false })
      .mockResolvedValueOnce({ commits: 1, headSha: "new", dirty: false })
      .mockResolvedValueOnce({ commits: 1, headSha: "first", dirty: false })
      .mockResolvedValueOnce({ commits: 1, headSha: "second", dirty: false });
    const result = await bindDeliverySteps(steps).reviewLoop({
      ...options,
      ciRepair: { harness: { kind: "claude", model: "repair" } },
    });
    expect(result).toMatchObject({ status: "limit-reached", phase: "ci-repair", attempts: 1 });
    expect(calls.filter((call) => call.harness.model === "repair")).toHaveLength(1);
    expect(calls.find((call) => call.harness.model === "repair")?.resume).toBeUndefined();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("acknowledges posted thread replies before asking the gate for another wake", async () => {
    const thread = {
      rootId: 4,
      path: "src/a.ts",
      line: 1,
      comments: [
        {
          id: 4,
          rootId: 4,
          path: "src/a.ts",
          line: 1,
          user: "reviewer",
          body: "Fix this",
          createdAt: "2026-01-01",
        },
      ],
    };
    const { steps, acks } = setup([
      { kind: "review-comments", threads: [thread] },
      { kind: "closed", merged: true },
    ]);
    const original = steps.agent;
    steps.agent = (async (config) =>
      config.prompt.includes("Address the review feedback")
        ? { text: "", output: { answers: [{ threadId: 4, body: "Fixed" }] } }
        : original(config)) as AgentFn;
    const result = await bindDeliverySteps(steps).reviewLoop(options);
    expect(result.status).toBe("merged");
    expect(acks[0]).toEqual({ selfCommentIds: [77] });
    expect(steps.replyToPullRequestReviewThread).toHaveBeenCalledWith(pr, 4, "Fixed");
  });

  it("does not report a refused merge as merged", async () => {
    const { steps } = setup([
      { kind: "merge-ready", headSha: "new" },
      { kind: "closed", merged: false },
    ]);
    vi.mocked(steps.squashMergePullRequest).mockResolvedValue({ merged: false, sha: "" });
    expect((await bindDeliverySteps(steps).reviewLoop({ ...options, merge: "jigs" })).status).toBe(
      "closed",
    );
  });

  it("rebuilds failed implementation sessions with full task context", async () => {
    const { steps } = setup();
    let reviews = 0;
    const prompts: string[] = [];
    steps.agent = (async (config) => {
      if (config.resume) resumeFailed("expired");
      prompts.push(config.prompt);
      if (config.output)
        return {
          text: "",
          output: { verdict: ++reviews === 1 ? "changes-requested" : "approved", findings: [] },
        };
      return { text: "", output: undefined, session: { harness: "codex", id: "saved" } };
    }) as AgentFn;
    const result = await bindDeliverySteps(steps).implementAndReview({ ...options, maxRounds: 2 });
    expect(result.status).toBe("approved");
    expect(prompts[2]).toContain("Find exact matches");
    expect(prompts[2]).toContain("Current diff:");
  });

  it("rejects invalid limits before running an agent", async () => {
    const { steps, calls } = setup();
    await expect(
      bindDeliverySteps(steps).reviewLoop({
        ...options,
        limits: { ...options.limits, ciFixAttempts: -1 },
      }),
    ).rejects.toThrow("ciFixAttempts");
    expect(calls).toHaveLength(0);
  });
  it("allows disabling CI repairs without calling a repair agent", async () => {
    const { steps, calls, closed } = setup([red("first")]);
    vi.mocked(steps.readBranchState).mockResolvedValue({
      commits: 1,
      headSha: "first",
      dirty: false,
    });
    const result = await bindDeliverySteps(steps).reviewLoop({
      ...options,
      limits: { ...options.limits, ciFixAttempts: 0 },
    });
    expect(result).toMatchObject({ status: "limit-reached", phase: "ci-repair", attempts: 0 });
    expect(calls).toHaveLength(3);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("does not count duplicate review events against the revision budget", async () => {
    const review: GateWake = {
      kind: "changes-requested",
      reviewId: 1,
      reviewer: "person",
      body: "Fix search",
      submittedAt: "today",
    };
    const { steps, calls } = setup([review, review, { ...review, reviewId: 2 }]);
    const result = await bindDeliverySteps(steps).reviewLoop({
      ...options,
      pullRequestRevision: { harness: { kind: "claude", model: "revision" } },
    });
    expect(result).toMatchObject({
      status: "limit-reached",
      phase: "pull-request-revision",
      attempts: 1,
    });
    expect(calls.filter((call) => call.harness.model === "revision")).toHaveLength(1);
  });

  it("applies the factory's description transformation before publishing", async () => {
    const { steps } = setup();
    await bindDeliverySteps(steps).reviewLoop({
      ...options,
      pullRequestDescription: {
        harness: { kind: "claude", model: "writer" },
        transform: (description, task) => ({
          ...description,
          title: `${task.key}: ${description.title}`,
        }),
      },
    });
    expect(steps.createPullRequest).toHaveBeenCalledWith(
      { owner: "owner", repo: "repo" },
      "fix",
      "main",
      "internal-42: fix: search",
      "Fixed and tested",
    );
  });

  it("stops before review when the implementation leaves the worktree dirty", async () => {
    const { steps, calls } = setup();
    vi.mocked(steps.readBranchState).mockResolvedValue({ commits: 1, headSha: "new", dirty: true });
    const result = await bindDeliverySteps(steps).reviewLoop(options);
    expect(result).toMatchObject({
      status: "uncommitted-work",
      phase: "implementation-review",
      attempts: 1,
      findings: ["The implementation left uncommitted changes; only committed work is reviewed."],
    });
    expect(result.change.worktree).toEqual(options.worktree);
    expect(calls.map((call) => call.harness.model)).toEqual(["builder"]);
    expect(steps.createPullRequest).not.toHaveBeenCalled();
  });

  it("stops before review when the implementation committed nothing", async () => {
    const { steps, calls } = setup();
    vi.mocked(steps.readBranchState).mockResolvedValue({
      commits: 0,
      headSha: "base",
      dirty: false,
    });
    const result = await bindDeliverySteps(steps).reviewLoop(options);
    expect(result).toMatchObject({
      status: "uncommitted-work",
      findings: ["The implementation added no commits since the base commit."],
    });
    expect(calls).toHaveLength(1);
    expect(steps.pushBranch).not.toHaveBeenCalled();
  });

  it("records the reviewed commit and shows it to the reviewer", async () => {
    const { steps, calls } = setup();
    vi.mocked(steps.readBranchState).mockResolvedValue({
      commits: 2,
      headSha: "reviewed",
      dirty: false,
    });
    const built = await bindDeliverySteps(steps).implementAndReview({ ...options, maxRounds: 1 });
    expect(built).toMatchObject({
      status: "approved",
      change: { approval: { reviewedCommit: "reviewed" } },
    });
    expect(calls[1]?.prompt).toContain("Head commit under review: reviewed");
  });

  it("refuses to publish a dirty worktree", async () => {
    const { steps } = setup();
    vi.mocked(steps.readBranchState).mockResolvedValue({ commits: 1, headSha: "new", dirty: true });
    await expect(bindDeliverySteps(steps).openPullRequest(publish)).rejects.toThrow(
      "uncommitted changes that no review approved",
    );
    expect(steps.pushBranch).not.toHaveBeenCalled();
    expect(steps.createPullRequest).not.toHaveBeenCalled();
  });

  it("refuses to publish a commit the review never saw", async () => {
    const { steps } = setup();
    vi.mocked(steps.readBranchState).mockResolvedValue({
      commits: 2,
      headSha: "later",
      dirty: false,
    });
    await expect(bindDeliverySteps(steps).openPullRequest(publish)).rejects.toThrow(
      "later is not the approved commit new",
    );
    expect(steps.pushBranch).not.toHaveBeenCalled();
  });

  it("publishes the approved commit without an implementation agent turn", async () => {
    const { steps, calls } = setup();
    expect(await bindDeliverySteps(steps).openPullRequest(publish)).toEqual(pr);
    expect(steps.pushBranch).toHaveBeenCalledExactlyOnceWith("/work", "fix");
    expect(steps.createPullRequest).toHaveBeenCalledWith(
      { owner: "owner", repo: "repo" },
      "fix",
      "main",
      "fix: search",
      "Fixed and tested",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("Write a concise");
  });
  it("lets a factory retain its own task fields and use them in prompt functions", async () => {
    const { steps, calls } = setup();
    const incident = {
      ...options.task,
      key: "overnight audit / storage",
      service: "bucket-a",
      impact: "unexpected growth",
    };
    const result = await bindDeliverySteps(steps).reviewLoop({
      ...options,
      task: incident,
      implementation: {
        harness: options.implementation.harness,
        prompt: ({ task }) =>
          `${task.instructions}\nInvestigate ${incident.service}: ${incident.impact}`,
      },
    });
    expect(result.status).toBe("merged");
    expect(calls[0]?.prompt).toContain("bucket-a: unexpected growth");
    expect(result.change.task.key).toBe("overnight audit / storage");
  });
  it("ignores an old CI failure after a revision has moved the branch", async () => {
    const { steps, calls } = setup([red("old"), { kind: "closed", merged: true }]);
    const result = await bindDeliverySteps(steps).reviewLoop(options);
    expect(result.change.attempts.ciFixAttempts).toBe(0);
    expect(calls).toHaveLength(3);
  });

  it("ignores historical approvals and merges only the current ready commit", async () => {
    const { steps } = setup([
      { kind: "approved", reviewId: 1, reviewer: "person", submittedAt: "today" },
      { kind: "ci-green", headSha: "new" },
      { kind: "merge-ready", headSha: "new" },
    ]);
    const result = await bindDeliverySteps(steps).reviewLoop({ ...options, merge: "jigs" });
    expect(result.status).toBe("merged");
    expect(steps.squashMergePullRequest).toHaveBeenCalledExactlyOnceWith(pr, "new");
  });
});
