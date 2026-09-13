import { describe, expect, it, vi } from "vitest";
import type { PrSnapshot } from "../../providers/github.ts";
import type { AgentFn } from "../agent/resume-or-rebuild.ts";
import { resumeFailed } from "../agent/resume-or-rebuild.ts";
import type { GateAck, GateWake } from "../pull-request/gate.ts";
import { pullRequestGate } from "../pull-request/gate.ts";
import { bindDeliverySteps } from "./bind.ts";
import {
  defaultCiRepairPrompt,
  defaultDescriptionPrompt,
  defaultImplementationPrompt,
  defaultReviewPrompt,
  defaultRevisionPrompt,
} from "./prompts.ts";
import type {
  ApprovedChange,
  DeliverChangeOptions,
  DeliverySteps,
  FollowPullRequestOptions,
} from "./types.ts";

// The real gate reaches the SDK through this one hook. Resolving straight
// through turns a suspension into the next round, which is all these tests
// need from it.
vi.mock("workflow", () => ({
  createHook: () => ({
    getConflict: async () => null,
    // biome-ignore lint/suspicious/noThenProperty: the SDK's Hook is a thenable
    then: (onfulfilled: (value: unknown) => unknown) => Promise.resolve().then(onfulfilled),
    dispose: () => {},
  }),
}));

const pr = { owner: "owner", repo: "repo", number: 1 };
const options: DeliverChangeOptions = {
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
  const runAgent: AgentFn = async <T>(config: Parameters<AgentFn>[0]) => {
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
    runAgent,
    pullRequestGate: gate,
    readBranchState: vi.fn().mockResolvedValue({ commits: 1, headSha: "new", dirty: false }),
    readWorktreeDiff: vi.fn().mockResolvedValue("diff"),
    pushBranch: vi.fn().mockResolvedValue({ headSha: "new" }),
    pushApprovedChange: vi.fn().mockResolvedValue({ headSha: "new" }),
    resolveRepository: vi.fn().mockResolvedValue({ owner: "owner", repo: "repo" }),
    openPullRequest: vi.fn().mockResolvedValue(pr),
    commentOnPullRequest: vi.fn().mockResolvedValue({ id: 8800 }),
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
    const result = await bindDeliverySteps(steps).deliverChange(options);
    expect(result.status).toBe("merged");
    expect(result.change.worktree).toEqual(options.worktree);
    expect(calls.map((call) => call.harness.model)).toEqual(["builder", "reviewer", "builder"]);
    expect(calls[1]?.resume).toBeUndefined();
    expect(calls[2]?.resume).toBeUndefined();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("returns limit-reached without opening a PR or implicitly retrying", async () => {
    const { steps } = setup();
    const runAgent = vi.fn().mockImplementation(async (config) => ({
      text: "",
      output: config.output
        ? { verdict: "changes-requested", findings: ["Missing test"] }
        : undefined,
    }));
    steps.runAgent = runAgent;
    const result = await bindDeliverySteps(steps).deliverChange(options);
    expect(result).toMatchObject({
      status: "limit-reached",
      phase: "implementation-review",
      attempts: 2,
    });
    expect(runAgent).toHaveBeenCalledTimes(4);
    expect(steps.openPullRequest).not.toHaveBeenCalled();
  });

  it("only adds the explicitly granted attempts and passes human direction", async () => {
    const { steps } = setup();
    const prompts: string[] = [];
    steps.runAgent = (async (config) => {
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
    const result = await bindDeliverySteps(steps).deliverChange({ ...options, onLimit });
    expect(result).toMatchObject({ status: "stopped", attempts: 3 });
    expect(prompts[4]).toContain("Test Unicode");
    // The reviewer hears the human too: direction reaches both roles of the round.
    expect(prompts[5]).toContain("Test Unicode");
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
      .mockResolvedValueOnce({ commits: 1, headSha: "first", dirty: false })
      .mockResolvedValueOnce({ commits: 1, headSha: "new", dirty: false })
      .mockResolvedValueOnce({ commits: 1, headSha: "first", dirty: false })
      .mockResolvedValueOnce({ commits: 1, headSha: "second", dirty: false });
    const result = await bindDeliverySteps(steps).deliverChange({
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
    const original = steps.runAgent;
    steps.runAgent = (async (config) =>
      config.prompt.includes("Address the review feedback")
        ? { text: "", output: { answers: [{ threadId: 4, body: "Fixed" }] } }
        : original(config)) as AgentFn;
    const result = await bindDeliverySteps(steps).deliverChange(options);
    expect(result.status).toBe("merged");
    expect(acks[0]).toEqual({ selfCommentIds: [77], selfConversationCommentIds: [] });
    expect(steps.replyToPullRequestReviewThread).toHaveBeenCalledWith(pr, 4, "Fixed");
  });

  // The gate delivers a conversation comment once per version, so an edit
  // arrives under the same id. followPullRequest must not treat that id as
  // already handled, or the edited feedback is silently dropped.
  it("runs a revision round again for an edited conversation comment", async () => {
    const edited = (body: string): GateWake => ({
      kind: "review-comments",
      threads: [
        {
          rootId: 5150,
          path: "",
          line: null,
          origin: "conversation",
          comments: [
            {
              id: 5150,
              rootId: 5150,
              path: "",
              line: null,
              user: "reviewer",
              body,
              createdAt: "2026-01-01",
            },
          ],
        },
      ],
    });
    const { steps, calls } = setup([
      edited("rename this"),
      edited("rename this — and the caller too"),
      { kind: "closed", merged: true },
    ]);
    await bindDeliverySteps(steps).followPullRequest({
      change: { ...approved, attempts: { ...approved.attempts }, sessions: {} },
      pr,
      implementation: options.implementation,
      limits: { ciFixAttempts: 1, pullRequestRevisionRounds: 2 },
      merge: "human",
    });

    expect(calls).toHaveLength(2);
    // Both answers land on the conversation: a synthetic thread has no anchor.
    expect(steps.commentOnPullRequest).toHaveBeenCalledTimes(2);
    expect(steps.replyToPullRequestReviewThread).not.toHaveBeenCalled();
  });

  // followPullRequest keeps no comment set of its own any more, so this drives
  // the real gate: the guarantee that an answered comment does not buy a
  // second revision round is the gate's, and this is where the delivery loop
  // depends on it.
  it("does not run a second revision round for an inline comment the gate already delivered", async () => {
    const inlineThread = {
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
    const open: PrSnapshot = {
      state: "open",
      merged: false,
      headSha: "new",
      viewer: "salim",
      reviews: [],
      reviewThreads: [inlineThread],
      conversationComments: [],
      ci: "green",
      failingChecks: [],
    };
    // The same unanswered comment on every poll, then the PR closes.
    const staged: PrSnapshot[] = [open, open, { ...open, state: "closed", merged: true }];
    let round = 0;
    const { steps, calls } = setup();
    steps.pullRequestGate = (target) =>
      pullRequestGate(target, async () => {
        const next = staged[round++];
        if (next === undefined) throw new Error("the gate polled past the staged snapshots");
        return next;
      });

    const result = await bindDeliverySteps(steps).followPullRequest({
      change: { ...approved, attempts: { ...approved.attempts }, sessions: {} },
      pr,
      implementation: options.implementation,
      limits: { ciFixAttempts: 1, pullRequestRevisionRounds: 3 },
      merge: "human",
    });

    expect(result.status).toBe("merged");
    expect(calls).toHaveLength(1);
    expect(round).toBe(3);
  });

  it("does not report a refused merge as merged", async () => {
    const { steps } = setup([
      { kind: "merge-ready", headSha: "new" },
      { kind: "closed", merged: false },
    ]);
    vi.mocked(steps.squashMergePullRequest).mockResolvedValue({ merged: false, sha: "" });
    expect(
      (await bindDeliverySteps(steps).deliverChange({ ...options, merge: "jigs" })).status,
    ).toBe("closed");
  });

  it("rebuilds failed implementation sessions with full task context", async () => {
    const { steps } = setup();
    let reviews = 0;
    const prompts: string[] = [];
    steps.runAgent = (async (config) => {
      if (config.resume) resumeFailed("expired");
      prompts.push(config.prompt);
      if (config.output)
        return {
          text: "",
          output: { verdict: ++reviews === 1 ? "changes-requested" : "approved", findings: [] },
        };
      return { text: "", output: undefined, session: { harness: "codex", id: "saved" } };
    }) as AgentFn;
    const result = await bindDeliverySteps(steps).implementAndReview({
      ...options,
      limits: { implementationReviewRounds: 2 },
    });
    expect(result.status).toBe("approved");
    expect(prompts[2]).toContain("Find exact matches");
    expect(prompts[2]).toContain("Current diff:");
  });

  it("rejects invalid limits before running an agent", async () => {
    const { steps, calls } = setup();
    await expect(
      bindDeliverySteps(steps).deliverChange({
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
    const result = await bindDeliverySteps(steps).deliverChange({
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
    const result = await bindDeliverySteps(steps).deliverChange({
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
    await bindDeliverySteps(steps).deliverChange({
      ...options,
      pullRequestDescription: {
        harness: { kind: "claude", model: "writer" },
        transform: (description, task) => ({
          ...description,
          title: `${task.key}: ${description.title}`,
        }),
      },
    });
    expect(steps.openPullRequest).toHaveBeenCalledWith(
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
    const result = await bindDeliverySteps(steps).deliverChange(options);
    expect(result).toMatchObject({
      status: "uncommitted-work",
      phase: "implementation-review",
      attempts: 1,
      findings: ["The implementation left uncommitted changes; only committed work is reviewed."],
    });
    expect(result.change.worktree).toEqual(options.worktree);
    expect(calls.map((call) => call.harness.model)).toEqual(["builder"]);
    expect(steps.openPullRequest).not.toHaveBeenCalled();
  });

  it("stops before review when the implementation committed nothing", async () => {
    const { steps, calls } = setup();
    vi.mocked(steps.readBranchState).mockResolvedValue({
      commits: 0,
      headSha: "base",
      dirty: false,
    });
    const result = await bindDeliverySteps(steps).deliverChange(options);
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
    const built = await bindDeliverySteps(steps).implementAndReview({
      ...options,
      limits: { implementationReviewRounds: 1 },
    });
    expect(built).toMatchObject({
      status: "approved",
      change: { approval: { reviewedCommit: "reviewed" } },
    });
    expect(calls[1]?.prompt).toContain("Head commit under review: reviewed");
  });

  it("does not open a PR when the durable approval check rejects publication", async () => {
    const { steps, calls } = setup();
    vi.mocked(steps.pushApprovedChange).mockRejectedValue(new Error("Unapproved work"));
    await expect(bindDeliverySteps(steps).publishApprovedChange(publish)).rejects.toThrow(
      "Unapproved work",
    );
    expect(steps.openPullRequest).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("publishes the approved commit without an implementation agent turn", async () => {
    const { steps, calls } = setup();
    expect(await bindDeliverySteps(steps).publishApprovedChange(publish)).toEqual(pr);
    expect(steps.pushApprovedChange).toHaveBeenCalledExactlyOnceWith("/work", "fix", "new");
    expect(steps.readBranchState).not.toHaveBeenCalled();
    expect(steps.pushBranch).not.toHaveBeenCalled();
    expect(steps.openPullRequest).toHaveBeenCalledWith(
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
    const result = await bindDeliverySteps(steps).deliverChange({
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
    const result = await bindDeliverySteps(steps).deliverChange(options);
    expect(result.change.attempts.ciFixAttempts).toBe(0);
    expect(calls).toHaveLength(3);
  });

  it("ignores historical approvals and merges only the current ready commit", async () => {
    const { steps } = setup([
      { kind: "approved", reviewId: 1, reviewer: "person", submittedAt: "today" },
      { kind: "ci-green", headSha: "new" },
      { kind: "merge-ready", headSha: "new" },
    ]);
    const result = await bindDeliverySteps(steps).deliverChange({ ...options, merge: "jigs" });
    expect(result.status).toBe("merged");
    expect(steps.squashMergePullRequest).toHaveBeenCalledExactlyOnceWith(pr, "new");
  });
  it("lets a role add to the prompt jigs would have sent", async () => {
    const { steps, calls } = setup();
    await bindDeliverySteps(steps).deliverChange({
      ...options,
      implementation: {
        harness: options.implementation.harness,
        prompt: async (context) =>
          `${await context.renderDefaultPrompt()}\n\nAlso check the migration.`,
      },
    });
    expect(calls[0]?.prompt).toContain("Implement the requirements and address the findings.");
    expect(calls[0]?.prompt).toContain("Find exact matches");
    expect(calls[0]?.prompt?.endsWith("Also check the migration.")).toBe(true);
  });

  it("lets a role ignore the renderer and replace the prompt outright", async () => {
    const { steps, calls } = setup();
    await bindDeliverySteps(steps).deliverChange({
      ...options,
      implementation: {
        harness: options.implementation.harness,
        prompt: () => "Rewrite the search index.",
      },
    });
    expect(calls[0]?.prompt).toBe("Rewrite the search index.");
  });

  it("does not read an unused implementation diff when its replacement runs", async () => {
    const { steps, calls } = setup();
    vi.mocked(steps.readWorktreeDiff).mockRejectedValue(new Error("Diff unavailable"));
    vi.mocked(steps.readBranchState).mockResolvedValue({
      commits: 0,
      headSha: "base",
      dirty: true,
    });
    const result = await bindDeliverySteps(steps).implementAndReview({
      ...options,
      implementation: { ...options.implementation, prompt: () => "Follow TASK.md" },
    });
    expect(calls[0]?.prompt).toBe("Follow TASK.md");
    expect(result.status).toBe("uncommitted-work");
    expect(steps.readWorktreeDiff).not.toHaveBeenCalled();
  });

  it.each(["ciRepair", "pullRequestRevision"] as const)(
    "does not read an unused diff for a replacement %s prompt",
    async (role) => {
      const { steps, calls } = setup([
        role === "ciRepair"
          ? red("first")
          : { kind: "review-comments", threads: [], body: "Fix search" },
        { kind: "closed", merged: true },
      ]);
      vi.mocked(steps.readWorktreeDiff).mockRejectedValue(new Error("Diff unavailable"));
      vi.mocked(steps.readBranchState)
        .mockResolvedValueOnce({ commits: 1, headSha: "first", dirty: false })
        .mockResolvedValue({ commits: 2, headSha: "second", dirty: false });
      await bindDeliverySteps(steps).followPullRequest({
        change: { ...approved, attempts: { ...approved.attempts }, sessions: {} },
        pr,
        implementation: options.implementation,
        [role]: { ...options.implementation, prompt: () => "Follow TASK.md" },
        limits: { ciFixAttempts: 1, pullRequestRevisionRounds: 1 },
        merge: "human",
      });
      expect(calls[0]?.prompt).toBe("Follow TASK.md");
      expect(steps.readWorktreeDiff).not.toHaveBeenCalled();
    },
  );

  it("skips unused diffs even when a replacement rebuilds an expired session", async () => {
    const { steps, calls } = setup([red("first"), { kind: "closed", merged: true }]);
    const runAgent = steps.runAgent;
    steps.runAgent = async (config) => {
      if (config.resume) resumeFailed("expired");
      return runAgent(config);
    };
    vi.mocked(steps.readWorktreeDiff).mockRejectedValue(new Error("Diff unavailable"));
    vi.mocked(steps.readBranchState)
      .mockResolvedValueOnce({ commits: 1, headSha: "first", dirty: false })
      .mockResolvedValue({ commits: 2, headSha: "second", dirty: false });
    await bindDeliverySteps(steps).followPullRequest({
      change: {
        ...approved,
        attempts: { ...approved.attempts },
        sessions: {
          ciRepair: {
            harness: options.implementation.harness,
            session: { harness: "codex", id: "expired" },
          },
        },
      },
      pr,
      implementation: options.implementation,
      ciRepair: { ...options.implementation, prompt: () => "Follow TASK.md" },
      limits: { ciFixAttempts: 1, pullRequestRevisionRounds: 1 },
      merge: "human",
    });
    expect(calls[0]?.prompt).toBe("Follow TASK.md");
    expect(calls[0]?.resume).toBeUndefined();
    expect(steps.readWorktreeDiff).not.toHaveBeenCalled();
  });

  it("shares a fresh attempt's diff between custom and default prompt reads", async () => {
    const { steps, calls } = setup();
    vi.mocked(steps.readBranchState).mockResolvedValue({
      commits: 0,
      headSha: "base",
      dirty: true,
    });
    await bindDeliverySteps(steps).implementAndReview({
      ...options,
      implementation: {
        ...options.implementation,
        prompt: async ({ readDiff, renderDefaultPrompt }) => {
          expect(await readDiff?.()).toBe("diff");
          const first = await renderDefaultPrompt();
          expect(await renderDefaultPrompt()).toBe(first);
          return first;
        },
      },
    });
    expect(steps.readWorktreeDiff).toHaveBeenCalledExactlyOnceWith("/work", "base");
    expect(calls[0]?.prompt).toContain("Current diff:\ndiff");
  });

  it("sends each role the shipped default when it supplies no prompt", async () => {
    const { steps, calls } = setup();
    const shared = { task: options.task, worktree: options.worktree };
    const renderDefaultPrompt = async () => "";
    await bindDeliverySteps(steps).deliverChange(options);
    expect(calls[0]?.prompt).toBe(
      await defaultImplementationPrompt({
        ...shared,
        attempt: 1,
        findings: [],
        instructions: "",
        readDiff: async () => "diff",
        renderDefaultPrompt,
      }),
    );
    expect(calls[1]?.prompt).toBe(
      defaultReviewPrompt({
        ...shared,
        attempt: 1,
        baseCommit: "base",
        headCommit: "new",
        diff: "diff",
        instructions: "",
        renderDefaultPrompt,
      }),
    );
    expect(calls[2]?.prompt).toBe(
      defaultDescriptionPrompt({ ...shared, diff: "diff", renderDefaultPrompt }),
    );
  });

  it("still validates structured output when a role replaces the prompt", async () => {
    const { steps } = setup();
    await expect(
      bindDeliverySteps(steps).deliverChange({
        ...options,
        review: { harness: options.review.harness, prompt: () => "Say yes or no." },
      }),
    ).rejects.toThrow();
  });

  it("keeps a custom task's own fields on the limit callback and the result", async () => {
    const { steps } = setup();
    steps.runAgent = (async (config) => ({
      text: "",
      output: config.output ? { verdict: "changes-requested", findings: ["Test"] } : undefined,
    })) as AgentFn;
    const incident = { ...options.task, service: "bucket-a", impact: "unexpected growth" };
    const seen: string[] = [];
    const result = await bindDeliverySteps(steps).deliverChange({
      ...options,
      task: incident,
      onLimit: async (limit) => {
        seen.push(`${limit.task.service}: ${limit.task.impact}`);
        return { action: "stop" };
      },
    });
    expect(seen).toEqual(["bucket-a: unexpected growth"]);
    expect(result.change.task.impact).toBe("unexpected growth");
  });

  it("sends the pull-request revision role its shipped default", async () => {
    const thread = {
      rootId: 4,
      path: "src/a.ts",
      line: 1,
      comments: [],
    };
    const { steps, calls } = setup([
      { kind: "review-comments", threads: [thread], body: "Fix search" },
      { kind: "closed", merged: true },
    ]);
    await bindDeliverySteps(steps).followPullRequest({
      change: { ...approved, attempts: { ...approved.attempts }, sessions: {} },
      pr,
      implementation: options.implementation,
      limits: { ciFixAttempts: 1, pullRequestRevisionRounds: 1 },
      merge: "human",
    });
    expect(calls[0]?.prompt).toBe(
      await defaultRevisionPrompt({
        task: options.task,
        worktree: options.worktree,
        pr,
        attempt: 1,
        instructions: "",
        threads: [thread],
        reviewBody: "Fix search",
        readDiff: async () => "diff",
        renderDefaultPrompt: async () => "",
      }),
    );
  });

  it("reads no diff on the resume arm and renders one on the rebuild arm", async () => {
    const follow = (sessions: ApprovedChange["sessions"]): FollowPullRequestOptions => ({
      change: { ...approved, attempts: { ...approved.attempts }, sessions },
      pr,
      implementation: options.implementation,
      limits: { ciFixAttempts: 1, pullRequestRevisionRounds: 1 },
      merge: "human",
    });
    const branchStates = (steps: DeliverySteps) =>
      vi
        .mocked(steps.readBranchState)
        .mockResolvedValueOnce({ commits: 1, headSha: "first", dirty: false })
        .mockResolvedValueOnce({ commits: 2, headSha: "second", dirty: false });

    const resumed = setup([red("first"), { kind: "closed", merged: true }]);
    branchStates(resumed.steps);
    await bindDeliverySteps(resumed.steps).followPullRequest(
      follow({
        ciRepair: {
          harness: options.implementation.harness,
          session: { harness: "codex", id: "saved" },
        },
      }),
    );
    expect(resumed.steps.readWorktreeDiff).not.toHaveBeenCalled();
    expect(resumed.calls[0]?.resume).toEqual({ harness: "codex", id: "saved" });
    expect(resumed.calls[0]?.prompt).not.toContain("Current diff:");

    const rebuilt = setup([red("first"), { kind: "closed", merged: true }]);
    branchStates(rebuilt.steps);
    await bindDeliverySteps(rebuilt.steps).followPullRequest(follow({}));
    expect(rebuilt.steps.readWorktreeDiff).toHaveBeenCalledExactlyOnceWith("/work", "base");
    expect(rebuilt.calls[0]?.resume).toBeUndefined();
    expect(rebuilt.calls[0]?.prompt).toContain("Current diff:\ndiff");
    expect(rebuilt.calls[0]?.prompt).toBe(
      await defaultCiRepairPrompt({
        task: options.task,
        worktree: options.worktree,
        pr,
        attempt: 1,
        instructions: "",
        failing: [],
        readDiff: async () => "diff",
        renderDefaultPrompt: async () => "",
      }),
    );
  });
});
