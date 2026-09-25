import { describe, expect, it, vi } from "vitest";

type PullRequestSnapshot = Awaited<
  ReturnType<typeof import("@jigs-ai/jigs/steps/pull-requests").fetchPullRequestState>
>;
type PullRequestComment = PullRequestSnapshot["conversationComments"][number];
type ReviewThread = PullRequestSnapshot["reviewThreads"][number];

import type { Harness, RunAgentFn } from "@jigs-ai/jigs/blocks/agents";
import { harnesses, models, unwrapAgentStep } from "@jigs-ai/jigs/blocks/agents";

const resumeFailed = (detail: string) => unwrapAgentStep({ resumeFailed: detail });

import type { MergePolicy, PullRequestWake } from "@jigs-ai/jigs/blocks/pull-requests";
import { parseMarkers, pullRequestGate } from "@jigs-ai/jigs/blocks/pull-requests";
import * as jigsRoutines from "#jigs/routines";
import * as jigsSteps from "#jigs/steps";
import * as delivery from "./delivery.ts";
import { pullRequestDescription } from "./outputs.ts";

interface DeliverySteps {
  runAgent: typeof jigs.runAgent;
  pullRequestGate: typeof jigs.pullRequestGate;
  postNote: PostDeliveryNote;
  readBranchState: typeof jigs.readBranchState;
  readWorktreeDiff: typeof jigs.readWorktreeDiff;
  pushBranch: typeof jigs.pushBranch;
  pushApprovedChange: typeof jigs.pushApprovedChange;
  resolveRepository: typeof jigs.resolveRepository;
  openPullRequest: typeof jigs.openPullRequest;
  registerResource: typeof jigs.registerResource;
  commentOnPullRequest: typeof import("@jigs-ai/jigs/steps/pull-requests").commentOnPullRequest;
  replyToPullRequestReviewThread: typeof import("@jigs-ai/jigs/steps/pull-requests").replyToPullRequestReviewThread;
  mergePullRequest: typeof jigs.mergePullRequest;
}
const jigs = { ...jigsRoutines, ...jigsSteps };
vi.mock("#jigs/routines", () => ({
  runAgent: vi.fn(),
  pullRequestGate: vi.fn(),
}));
vi.mock("#jigs/steps", () => ({
  readBranchState: vi.fn(),
  readWorktreeDiff: vi.fn(),
  pushBranch: vi.fn(),
  pushApprovedChange: vi.fn(),
  resolveRepository: vi.fn(),
  openPullRequest: vi.fn(),
  registerResource: vi.fn(),
  commentOnPullRequest: vi.fn(),
  replyToPullRequestReviewThread: vi.fn(),
  mergePullRequest: vi.fn(),
}));
// Handed to delivery through `options`; each test's steps supply what it does.
const postNote = vi.fn<PostDeliveryNote>();
function useSteps(steps: DeliverySteps) {
  vi.mocked(jigs.runAgent).mockImplementation(steps.runAgent);
  vi.mocked(jigs.pullRequestGate).mockImplementation(steps.pullRequestGate);
  postNote.mockImplementation(steps.postNote);
  vi.mocked(jigs.readBranchState).mockImplementation(steps.readBranchState);
  vi.mocked(jigs.readWorktreeDiff).mockImplementation(steps.readWorktreeDiff);
  vi.mocked(jigs.pushBranch).mockImplementation(steps.pushBranch);
  vi.mocked(jigs.pushApprovedChange).mockImplementation(steps.pushApprovedChange);
  vi.mocked(jigs.resolveRepository).mockImplementation(steps.resolveRepository);
  vi.mocked(jigs.openPullRequest).mockImplementation(steps.openPullRequest);
  vi.mocked(jigs.registerResource).mockImplementation(steps.registerResource);
  vi.mocked(jigs.commentOnPullRequest).mockImplementation(steps.commentOnPullRequest);
  vi.mocked(jigs.replyToPullRequestReviewThread).mockImplementation(
    steps.replyToPullRequestReviewThread,
  );
  vi.mocked(jigs.mergePullRequest).mockImplementation(steps.mergePullRequest);
  return delivery;
}

import {
  defaultCiRepairPrompt,
  defaultDescriptionPrompt,
  defaultImplementationPrompt,
  defaultReviewPrompt,
  defaultRevisionPrompt,
} from "./prompts.ts";
import { implementationReport, type ReviewFinding, reviewVerdict } from "./review.ts";
import type {
  ApprovedChange,
  DeliverChangeOptions,
  FollowPullRequestOptions,
  PostDeliveryNote,
} from "./types.ts";

// The real gate reaches the SDK through this one hook. Resolving straight
// through turns a suspension into the next round, which is all these tests
// need from it.
vi.mock("workflow", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "wrun_TEST", workflowName: "linear-ticket-to-pr" }),
  createHook: () => ({
    getConflict: async () => null,
    // biome-ignore lint/suspicious/noThenProperty: the SDK's Hook is a thenable
    then: (onfulfilled: (value: unknown) => unknown) => Promise.resolve().then(onfulfilled),
    dispose: () => {},
  }),
}));

const pr = {
  owner: "owner",
  repo: "repo",
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
};

// Keyed on the schema the operation asked for, not on the prompt: a role that
// replaces its prompt entirely still owes the same answer shape.
// Through `unknown`, because a role's schema reaches the fake as the generic
// `ZodType<T>` the operation asked with.
const wants = (output: unknown, schema: unknown): boolean => output === schema;

const blocking = (summary: string): { findings: ReviewFinding[]; verdict: string } => ({
  verdict: "changes-requested",
  findings: [{ summary, blocking: true }],
});

const answerFor = (schema: unknown): unknown => {
  if (schema === reviewVerdict) return { verdict: "approved", findings: [] };
  if (schema === implementationReport) return { responses: [] };
  if (schema === pullRequestDescription) return { title: "fix: search", body: "Fixed and tested" };
  return { answers: [{ threadId: null, body: "Done" }], commitExplanation: null };
};

const markersOf = (body: string | undefined) => parseMarkers(body ?? "");

const HUMAN_MERGE: MergePolicy = {
  by: "human",
  method: "squash",
  approval: { kind: "review" },
};
const JIGS_MERGE: MergePolicy = { ...HUMAN_MERGE, by: "jigs" };

const openSnapshot = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  state: "open",
  merged: false,
  draft: false,
  mergeState: "clean",
  labels: [],
  mergeCommitSha: null,
  headSha: "new",
  reviews: [],
  reviewThreads: [],
  conversationComments: [],
  ci: "green",
  failingChecks: [],
  ...overrides,
});
const options: DeliverChangeOptions = {
  task: {
    id: "68bc9696-35d5-442d-ab56-214c8cfefbec",
    key: "internal-42",
    title: "Repair search",
    instructions: "Find exact matches",
  },
  worktree: { path: "/work", branch: "fix", defaultBranch: "main", baseSha: "base" },
  binding: "repo",
  implementation: { harness: { kind: "codex", model: "builder" } },
  review: { harness: { kind: "claude", model: "reviewer" } },
  limits: { implementationReviewRounds: 2, ciFixAttempts: 1, pullRequestRevisionRounds: 1 },
  merge: HUMAN_MERGE,
  postNote,
};

function setup(wakes: PullRequestWake[] = [{ kind: "closed", merged: true }]) {
  const calls: Array<{
    harness: Parameters<RunAgentFn>[0]["harness"];
    prompt: string;
    resume?: unknown;
  }> = [];
  const runAgent: RunAgentFn = async <T>(config: Parameters<RunAgentFn>[0]) => {
    calls.push(config);
    const output = config.output?.parse(answerFor(config.output)) as T;
    return { text: "", output, session: { harness: config.harness.kind, id: "session" } };
  };
  const closed = vi.fn();
  async function* gate(): AsyncGenerator<PullRequestWake, void, undefined> {
    try {
      for (const wake of wakes) yield wake;
    } finally {
      closed();
    }
  }
  const steps: DeliverySteps = {
    runAgent,
    pullRequestGate: gate,
    postNote: vi.fn().mockResolvedValue(undefined),
    readBranchState: vi.fn().mockResolvedValue({ commits: 1, headSha: "new", dirty: false }),
    readWorktreeDiff: vi.fn().mockResolvedValue("diff"),
    pushBranch: vi.fn().mockResolvedValue({ headSha: "new" }),
    pushApprovedChange: vi.fn().mockResolvedValue({ headSha: "new" }),
    resolveRepository: vi.fn().mockResolvedValue({ owner: "owner", repo: "repo" }),
    openPullRequest: vi.fn().mockResolvedValue(pr),
    registerResource: vi.fn().mockResolvedValue(undefined),
    commentOnPullRequest: vi.fn().mockResolvedValue({ id: 8800 }),
    replyToPullRequestReviewThread: vi.fn().mockResolvedValue({ id: 77 }),
    mergePullRequest: vi.fn().mockResolvedValue({ merged: true, sha: "merged" }),
  };
  return { steps, calls, closed };
}

const approved: ApprovedChange = {
  task: options.task,
  worktree: options.worktree,
  attempts: { implementationReviewRounds: 1, ciFixAttempts: 0, pullRequestRevisionRounds: 0 },
  sessions: {},
  review: [],
  approval: { reviewedCommit: "new" },
};

const publish = { change: approved, binding: "repo", implementation: options.implementation };

const mergeReady = (headSha: string, retryNoted = false): PullRequestWake => ({
  kind: "merge-ready",
  headSha,
  retryNoted,
});

const red = (headSha: string): PullRequestWake => ({
  kind: "ci-red",
  headSha,
  failing: [],
  mentionLogin: null,
});

describe("delivery", () => {
  it("delivers a provider-independent task with separate roles and retains worktree facts", async () => {
    const { steps, calls, closed } = setup();
    const result = await useSteps(steps).deliverChange(options);
    expect(result.pr).toEqual(pr);
    expect(result.change.worktree).toEqual(options.worktree);
    expect(calls.map((call) => call.harness.model)).toEqual(["builder", "reviewer", "builder"]);
    expect(calls[1]?.resume).toBeUndefined();
    expect(calls[2]?.resume).toBeUndefined();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("calls lifecycle callbacks after opening and resource registration, on either merged return, and before a stop throws", async () => {
    const events: string[] = [];
    const on = {
      pullRequestOpened: async () => {
        events.push("opened");
      },
      merged: async () => {
        events.push("merged");
      },
      stopped: async () => {
        events.push("stopped");
      },
    };
    const { steps } = setup([{ kind: "closed", merged: true }]);
    vi.mocked(steps.openPullRequest).mockImplementation(async () => {
      events.push("open");
      return pr;
    });
    vi.mocked(steps.registerResource).mockImplementation(async (resource) => {
      events.push("resource");
      return resource;
    });
    await useSteps(steps).deliverChange({ ...options, on });
    expect(events).toEqual(["open", "resource", "opened", "merged"]);

    events.length = 0;
    const stopped = setup([{ kind: "closed", merged: false }]);
    vi.mocked(stopped.steps.openPullRequest).mockImplementation(async () => {
      events.push("open");
      return pr;
    });
    vi.mocked(stopped.steps.registerResource).mockImplementation(async (resource) => {
      events.push("resource");
      return resource;
    });
    await useSteps(stopped.steps)
      .deliverChange({ ...options, on })
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        events.push("throw");
      });
    expect(events).toEqual(["open", "resource", "opened", "stopped", "throw"]);
  });

  it("does not require lifecycle callbacks", async () => {
    const { steps } = setup([{ kind: "closed", merged: true }]);
    await expect(useSteps(steps).deliverChange(options)).resolves.toMatchObject({ pr });
  });

  it("calls merged when jigs merges instead of waiting for the closed wake", async () => {
    const merged = vi.fn(async () => {});
    const { steps } = setup([mergeReady("new")]);
    await useSteps(steps).deliverChange({ ...options, merge: JIGS_MERGE, on: { merged } });
    expect(merged).toHaveBeenCalledWith(pr);
  });

  it("fails at the round limit without opening a PR or implicitly retrying", async () => {
    const { steps } = setup();
    const runAgent = vi.fn().mockImplementation(async (config) => ({
      text: "",
      output: wants(config.output, implementationReport)
        ? { responses: [] }
        : blocking("Missing test"),
    }));
    steps.runAgent = runAgent;
    await expect(useSteps(steps).deliverChange(options)).rejects.toThrow(
      "after 2 implementation review round(s) without an approved change. The work is pushed on branch fix",
    );
    expect(runAgent).toHaveBeenCalledTimes(4);
    expect(steps.openPullRequest).not.toHaveBeenCalled();
  });

  it("approves a round whose findings are all non-blocking and keeps them for the PR body", async () => {
    const { steps, calls } = setup();
    steps.runAgent = (async (config) =>
      calls.push(config) && wants(config.output, reviewVerdict)
        ? {
            text: "",
            output: {
              verdict: "changes-requested",
              findings: [
                { summary: "Reorder the doc sentences", blocking: false },
                { summary: "A third test case would be nice", blocking: false },
              ],
            },
          }
        : {
            text: "",
            output: wants(config.output, implementationReport)
              ? { responses: [] }
              : answerFor(config.output),
          }) as RunAgentFn;
    const result = await useSteps(steps).deliverChange(options);
    expect(result.pr).toEqual(pr);
    // One round: the preferences did not send it back to the builder.
    expect(result.change.attempts.implementationReviewRounds).toBe(1);
    expect(calls.filter((call) => call.harness.model === "builder")).toHaveLength(2);
    const body = vi.mocked(steps.openPullRequest).mock.calls[0]?.[0].body ?? "";
    expect(body).toContain("Reviewer notes");
    expect(body).toContain("- Reorder the doc sentences");
    expect(body).toContain("- A third test case would be nice");
  });

  it("sends the next round back to the builder while one finding still blocks", async () => {
    const { steps } = setup();
    let round = 0;
    steps.runAgent = (async (config) =>
      wants(config.output, reviewVerdict)
        ? {
            text: "",
            output:
              ++round === 1
                ? {
                    verdict: "changes-requested",
                    findings: [
                      { summary: "The check never fires", blocking: true },
                      { summary: "Reorder the doc sentences", blocking: false },
                    ],
                  }
                : { verdict: "approved", findings: [] },
          }
        : {
            text: "",
            output: wants(config.output, implementationReport)
              ? { responses: [] }
              : answerFor(config.output),
          }) as RunAgentFn;
    const result = await useSteps(steps).deliverChange(options);
    expect(result.change.attempts.implementationReviewRounds).toBe(2);
    expect(vi.mocked(steps.openPullRequest).mock.calls[0]?.[0].body).not.toContain(
      "Reviewer notes",
    );
  });

  it("resumes the reviewer's own session and hands it the builder's answers", async () => {
    const { steps, calls } = setup();
    let round = 0;
    steps.runAgent = (async (config) => {
      calls.push(config);
      if (wants(config.output, reviewVerdict)) {
        return {
          text: "",
          output:
            ++round === 1
              ? blocking("The check never fires")
              : { verdict: "approved", findings: [] },
          session: { harness: "claude" as const, id: "reviewer-session" },
        };
      }
      return {
        text: "",
        output: {
          responses: [
            { finding: "The check never fires", changed: false, detail: "The caller guards it" },
          ],
        },
        session: { harness: "codex" as const, id: "builder-session" },
      };
    }) as RunAgentFn;
    const result = await useSteps(steps).implementAndReview({
      ...options,
      limits: { implementationReviewRounds: 2 },
    });
    expect(result.change.approval.reviewedCommit).toBe("new");
    const reviews = calls.filter((call) => call.harness.model === "reviewer");
    expect(reviews[0]?.resume).toBeUndefined();
    expect(reviews[1]?.resume).toEqual({ harness: "claude", id: "reviewer-session" });
    expect(reviews[1]?.prompt).toContain("not changed: The caller guards it");
    // The resumed reviewer already holds its earlier rounds.
    expect(reviews[1]?.prompt).not.toContain("Earlier rounds of this review");
    expect(result.change.sessions.review).toEqual({
      harness: options.review.harness,
      session: { harness: "claude", id: "reviewer-session" },
    });
    expect(result.change.review.map((entry) => entry.verdict)).toEqual([
      "changes-requested",
      "approved",
    ]);
  });

  it("gives a reviewer whose session expired the whole findings ledger", async () => {
    const { steps, calls } = setup();
    let round = 0;
    steps.runAgent = (async (config) => {
      calls.push(config);
      if (wants(config.output, reviewVerdict)) {
        if (config.resume) resumeFailed("expired");
        return {
          text: "",
          output:
            ++round === 1
              ? {
                  verdict: "changes-requested",
                  findings: [
                    { summary: "The check never fires", blocking: true },
                    { summary: "Reorder the doc sentences", blocking: false },
                  ],
                }
              : { verdict: "approved", findings: [] },
          session: { harness: "claude" as const, id: "reviewer-session" },
        };
      }
      return {
        text: "",
        output: {
          responses: [
            { finding: "The check never fires", changed: true, detail: "Called it from bind" },
          ],
        },
        session: { harness: "codex" as const, id: "builder-session" },
      };
    }) as RunAgentFn;
    const result = await useSteps(steps).implementAndReview({
      ...options,
      limits: { implementationReviewRounds: 2 },
    });
    expect(result.change.approval.reviewedCommit).toBe("new");
    const rebuilt = calls.filter((call) => call.harness.model === "reviewer").at(-1)?.prompt ?? "";
    expect(rebuilt).toContain("Earlier rounds of this review");
    expect(rebuilt).toContain("Round 1 — changes-requested");
    expect(rebuilt).toContain("- The check never fires");
    expect(rebuilt).toContain("- Reorder the doc sentences (non-blocking)");
    expect(rebuilt).toContain("Called it from bind");
    // The round being judged is not in its own ledger.
    expect(rebuilt).not.toContain("Round 2");
  });

  it("pushes the branch and posts the open findings on the ticket when the budget runs out", async () => {
    const { steps } = setup();
    steps.runAgent = (async (config) => ({
      text: "",
      output: wants(config.output, implementationReport)
        ? { responses: [] }
        : {
            verdict: "changes-requested",
            findings: [
              { summary: "The check never fires", blocking: true },
              { summary: "Reorder the doc sentences", blocking: false },
            ],
          },
    })) as RunAgentFn;
    await expect(useSteps(steps).deliverChange(options)).rejects.toThrow(
      "The work is pushed on branch fix",
    );
    expect(steps.pushBranch).toHaveBeenCalledWith("/work", "fix");
    expect(steps.postNote).toHaveBeenCalledOnce();
    const [note] = vi.mocked(steps.postNote).mock.calls[0] ?? [];
    expect(note?.headline).toContain("internal-42");
    expect(note?.notes).toEqual([
      "The check never fires",
      "Reorder the doc sentences (non-blocking)",
      "The work is on branch `fix`, pushed, in the worktree at `/work`.",
    ]);
    expect(steps.openPullRequest).not.toHaveBeenCalled();
  });

  it("pushes and reports a limit that onLimit declines", async () => {
    const { steps } = setup();
    steps.runAgent = (async (config) => ({
      text: "",
      output: wants(config.output, implementationReport)
        ? { responses: [] }
        : blocking("Missing test"),
    })) as RunAgentFn;
    await expect(
      useSteps(steps).deliverChange({
        ...options,
        onLimit: async () => ({ action: "stop" }),
      }),
    ).rejects.toThrow("The work is pushed on branch fix");
    expect(steps.pushBranch).toHaveBeenCalledWith("/work", "fix");
    expect(steps.postNote).toHaveBeenCalledOnce();
  });

  it("only adds the explicitly granted attempts and passes human direction", async () => {
    const { steps } = setup();
    const prompts: string[] = [];
    steps.runAgent = (async (config) => {
      prompts.push(config.prompt);
      return {
        text: "",
        output: wants(config.output, implementationReport) ? { responses: [] } : blocking("Test"),
      };
    }) as RunAgentFn;
    const onLimit = vi
      .fn()
      .mockResolvedValueOnce({
        action: "continue",
        additionalAttempts: 1,
        instructions: "Test Unicode",
      })
      .mockResolvedValueOnce({ action: "stop" });
    await expect(useSteps(steps).deliverChange({ ...options, onLimit })).rejects.toThrow(
      "after 3 implementation review round(s)",
    );
    expect(prompts[4]).toContain("Test Unicode");
    // The reviewer hears the human too: direction reaches both roles of the round.
    expect(prompts[5]).toContain("Test Unicode");
    expect(onLimit).toHaveBeenCalledTimes(2);
  });

  it("counts CI repairs cumulatively across heads and skips a red the branch moved past", async () => {
    const { steps, calls, closed } = setup([red("first"), red("stale"), red("second")]);
    vi.mocked(steps.readBranchState)
      .mockResolvedValueOnce({ commits: 1, headSha: "new", dirty: false })
      .mockResolvedValueOnce({ commits: 1, headSha: "first", dirty: false })
      .mockResolvedValueOnce({ commits: 1, headSha: "new", dirty: false })
      .mockResolvedValueOnce({ commits: 1, headSha: "first", dirty: false })
      .mockResolvedValueOnce({ commits: 1, headSha: "second", dirty: false });
    await expect(
      useSteps(steps).deliverChange({
        ...options,
        ciRepair: { harness: { kind: "claude", model: "repair" } },
      }),
    ).rejects.toThrow("after 1 ci-repair attempt(s). The work is pushed on branch fix");
    expect(calls.filter((call) => call.harness.model === "repair")).toHaveLength(1);
    expect(calls.find((call) => call.harness.model === "repair")?.resume).toBeUndefined();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("posts only the answer for a question-only revision round with no commit", async () => {
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
          body: "Why use a set here?",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
      ],
    };
    const { steps } = setup([
      { kind: "review-comments", threads: [thread] },
      { kind: "closed", merged: true },
    ]);
    const original = steps.runAgent;
    steps.runAgent = (async (config) =>
      config.prompt.includes("Address the review feedback")
        ? {
            text: "",
            output: config.output?.parse({
              answers: [{ threadId: 4, body: "It keeps membership checks constant-time." }],
              commitExplanation: "No changes were needed. The bind tests passed.",
            }),
          }
        : original(config)) as RunAgentFn;
    const result = await useSteps(steps).deliverChange(options);
    expect(result.pr).toEqual(pr);
    expect(steps.replyToPullRequestReviewThread).toHaveBeenCalledOnce();
    expect(steps.replyToPullRequestReviewThread).toHaveBeenCalledWith(
      pr,
      4,
      expect.stringContaining("It keeps membership checks constant-time."),
    );
    expect(markersOf(vi.mocked(steps.replyToPullRequestReviewThread).mock.calls[0]?.[2])).toEqual([
      {
        scope: "linear-ticket-to-pr/internal-42",
        run: "wrun_TEST",
        kind: "reply",
        source: "4@2026-01-01",
      },
    ]);
    expect(steps.commentOnPullRequest).not.toHaveBeenCalled();
  });

  it("posts one commit explanation, marked with the commit, when a revision pushes one", async () => {
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
          updatedAt: "2026-01-01",
        },
      ],
    };
    const { steps } = setup([
      { kind: "review-comments", threads: [thread] },
      { kind: "closed", merged: true },
    ]);
    vi.mocked(steps.readBranchState)
      .mockResolvedValueOnce({ commits: 1, headSha: "before", dirty: false })
      .mockResolvedValueOnce({ commits: 2, headSha: "after", dirty: false });
    steps.runAgent = (async (config) => ({
      text: "",
      output: config.output?.parse({
        answers: [{ threadId: 4, body: "Fixed." }],
        commitExplanation: "Changed the lookup and ran the bind tests.",
      }),
    })) as RunAgentFn;

    const result = await useSteps(steps).followPullRequest({
      change: { ...approved, attempts: { ...approved.attempts }, sessions: {}, review: [] },
      pr,
      implementation: options.implementation,
      postNote: options.postNote,
      limits: { ciFixAttempts: 1, pullRequestRevisionRounds: 1 },
      merge: HUMAN_MERGE,
    });

    expect(result.pr).toEqual(pr);
    expect(steps.pushBranch).toHaveBeenCalledOnce();
    expect(steps.replyToPullRequestReviewThread).toHaveBeenCalledOnce();
    expect(steps.commentOnPullRequest).toHaveBeenCalledOnce();
    expect(steps.commentOnPullRequest).toHaveBeenCalledWith(
      pr,
      expect.stringContaining("Changed the lookup and ran the bind tests."),
    );
    expect(markersOf(vi.mocked(steps.commentOnPullRequest).mock.calls[0]?.[1])).toEqual([
      {
        scope: "linear-ticket-to-pr/internal-42",
        run: "wrun_TEST",
        kind: "completion",
        source: "after",
      },
    ]);
  });

  // The gate delivers a conversation comment once per version, so an edit
  // arrives under the same id. followPullRequest must not treat that id as
  // already handled, or the edited feedback is silently dropped.
  it("runs a revision round again for an edited conversation comment", async () => {
    const edited = (body: string): PullRequestWake => ({
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
              updatedAt: body,
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
    await useSteps(steps).followPullRequest({
      change: { ...approved, attempts: { ...approved.attempts }, sessions: {}, review: [] },
      pr,
      implementation: options.implementation,
      postNote: options.postNote,
      limits: { ciFixAttempts: 1, pullRequestRevisionRounds: 2 },
      merge: HUMAN_MERGE,
    });

    expect(calls).toHaveLength(2);
    // Both answers land on the conversation: a synthetic thread has no anchor.
    expect(steps.commentOnPullRequest).toHaveBeenCalledTimes(2);
    expect(steps.replyToPullRequestReviewThread).not.toHaveBeenCalled();
  });

  // followPullRequest keeps no record of what it answered: the answer it posts
  // is the record. This drives the real gate against a pull request that keeps
  // the replies, which is what makes a repeated snapshot cost nothing.
  it("answers an inline comment once, however often the same state arrives", async () => {
    const thread: ReviewThread = {
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
          updatedAt: "2026-01-01",
        },
      ],
    };
    const conversation: PullRequestComment[] = [];
    const state = (): PullRequestSnapshot =>
      openSnapshot({
        reviewThreads: [{ ...thread, comments: [...thread.comments] }],
        conversationComments: [...conversation],
      });
    const { steps, calls } = setup();
    // The revision agent answers the thread by its rootId, as the prompt asks:
    // an inline comment is only answered in its own thread.
    const recorded = steps.runAgent;
    steps.runAgent = (async (config) => {
      const result = await recorded(config);
      return config.prompt.includes("Address the review feedback")
        ? {
            ...result,
            output: config.output?.parse({
              answers: [{ threadId: 4, body: "Fixed." }],
              commitExplanation: null,
            }),
          }
        : result;
    }) as RunAgentFn;
    steps.commentOnPullRequest = async (_target, body) => {
      conversation.push({
        id: 6,
        body,
        user: "salim",
        userType: "User",
        createdAt: "2026-01-02",
        updatedAt: "2026-01-02",
      });
      return { id: 6 };
    };
    steps.replyToPullRequestReviewThread = async (_target, rootId, body) => {
      thread.comments.push({
        id: 5,
        rootId,
        path: "src/a.ts",
        line: 1,
        user: "salim",
        body,
        createdAt: "2026-01-02",
        updatedAt: "2026-01-02",
      });
      return { id: 5 };
    };
    // The same pull request on every poll, then it closes.
    let round = 0;
    steps.pullRequestGate = (target, scope, approval) =>
      pullRequestGate(
        target,
        async () => (++round >= 3 ? { ...state(), state: "closed", merged: true } : state()),
        scope,
        approval,
      );

    const result = await useSteps(steps).followPullRequest({
      change: { ...approved, attempts: { ...approved.attempts }, sessions: {}, review: [] },
      pr,
      implementation: options.implementation,
      postNote: options.postNote,
      limits: { ciFixAttempts: 1, pullRequestRevisionRounds: 3 },
      merge: HUMAN_MERGE,
    });

    expect(result.pr).toEqual(pr);
    expect(calls).toHaveLength(1);
    expect(round).toBe(3);
  });

  it("does not report a refused merge as merged", async () => {
    const { steps } = setup([mergeReady("new"), { kind: "closed", merged: false }]);
    vi.mocked(steps.mergePullRequest).mockResolvedValue({
      merged: false,
      reason: "the head moved",
      transient: true,
    });
    await expect(useSteps(steps).deliverChange({ ...options, merge: JIGS_MERGE })).rejects.toThrow(
      "pull request owner/repo#1 was closed unmerged",
    );
    expect(steps.pushBranch).toHaveBeenCalledWith("/work", "fix");
    expect(steps.postNote).toHaveBeenCalledOnce();
  });

  it("retries a merge refused for a state that passes, and says so once", async () => {
    const { steps } = setup([mergeReady("new"), mergeReady("new", true)]);
    vi.mocked(steps.mergePullRequest)
      .mockResolvedValueOnce({
        merged: false,
        reason: "GitHub reports the merge state as unstable",
        transient: true,
      })
      .mockResolvedValueOnce({ merged: true, mergeCommitSha: "merged" });
    const result = await useSteps(steps).deliverChange({ ...options, merge: JIGS_MERGE });

    expect(result.pr).toEqual(pr);
    expect(steps.mergePullRequest).toHaveBeenCalledTimes(2);
    // One note, and it does not stand the commit down.
    expect(steps.commentOnPullRequest).toHaveBeenCalledOnce();
    const [, body] = vi.mocked(steps.commentOnPullRequest).mock.calls[0] ?? [];
    expect(body).toContain("I will try again");
    expect(body).toContain('"reason":"merge-retry"');
  });

  it("retries when a merge attempt throws, leaving the head eligible", async () => {
    const { steps } = setup([mergeReady("new"), mergeReady("new", true)]);
    vi.mocked(steps.mergePullRequest)
      .mockRejectedValueOnce(new Error("GitHub request timed out"))
      .mockResolvedValueOnce({ merged: true, mergeCommitSha: "merged" });

    const result = await useSteps(steps).deliverChange({ ...options, merge: JIGS_MERGE });

    expect(result.pr).toEqual(pr);
    expect(steps.mergePullRequest).toHaveBeenCalledTimes(2);
    expect(steps.commentOnPullRequest).toHaveBeenCalledOnce();
    const [, body] = vi.mocked(steps.commentOnPullRequest).mock.calls[0] ?? [];
    expect(body).toContain("GitHub request timed out");
    expect(body).toContain('"reason":"merge-retry"');
  });

  it("stands a commit down when nothing but a new commit could merge it", async () => {
    const { steps } = setup([mergeReady("new"), { kind: "closed", merged: false }]);
    vi.mocked(steps.mergePullRequest).mockResolvedValue({
      merged: false,
      reason: "the branch conflicts with its base",
      transient: false,
    });
    await expect(useSteps(steps).deliverChange({ ...options, merge: JIGS_MERGE })).rejects.toThrow(
      "pull request owner/repo#1 was closed unmerged",
    );
    const [, body] = vi.mocked(steps.commentOnPullRequest).mock.calls[0] ?? [];
    expect(body).toContain("I am standing down on new");
    expect(body).toContain('"reason":"merge"');
  });

  it("rebuilds failed implementation sessions with full task context", async () => {
    const { steps } = setup();
    let reviews = 0;
    const prompts: string[] = [];
    steps.runAgent = (async (config) => {
      if (config.resume) resumeFailed("expired");
      prompts.push(config.prompt);
      if (wants(config.output, reviewVerdict))
        return {
          text: "",
          output:
            ++reviews === 1 ? blocking("Missing test") : { verdict: "approved", findings: [] },
          session: { harness: "claude", id: "reviewer" },
        };
      return {
        text: "",
        output: { responses: [] },
        session: { harness: "codex", id: "saved" },
      };
    }) as RunAgentFn;
    const result = await useSteps(steps).implementAndReview({
      ...options,
      limits: { implementationReviewRounds: 2 },
    });
    expect(result.change.approval.reviewedCommit).toBe("new");
    expect(prompts[2]).toContain("Find exact matches");
    expect(prompts[2]).toContain("Current diff:");
  });

  it("rejects invalid limits before running an agent", async () => {
    const { steps, calls } = setup();
    await expect(
      useSteps(steps).deliverChange({
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
    await expect(
      useSteps(steps).deliverChange({
        ...options,
        limits: { ...options.limits, ciFixAttempts: 0 },
      }),
    ).rejects.toThrow("after 0 ci-repair attempt(s). The work is pushed on branch fix");
    expect(calls).toHaveLength(3);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("fails after preserving work when a CI repair produces no clean new commit", async () => {
    const { steps } = setup([red("first")]);
    vi.mocked(steps.readBranchState).mockResolvedValue({
      commits: 1,
      headSha: "first",
      dirty: false,
    });
    await expect(useSteps(steps).deliverChange(options)).rejects.toThrow(
      "CI repair attempt 1 produced no new clean commit. The work is pushed on branch fix",
    );
    expect(steps.pushBranch).toHaveBeenCalledWith("/work", "fix");
    expect(steps.postNote).toHaveBeenCalledOnce();
  });

  it("spends one revision round per feedback wake and stops at the budget", async () => {
    const summary: PullRequestWake = { kind: "review-comments", threads: [], body: "Fix search" };
    const { steps, calls } = setup([summary, summary]);
    await expect(
      useSteps(steps).deliverChange({
        ...options,
        pullRequestRevision: { harness: { kind: "claude", model: "revision" } },
      }),
    ).rejects.toThrow("after 1 pull-request-revision attempt(s)");
    expect(calls.filter((call) => call.harness.model === "revision")).toHaveLength(1);
  });

  it("applies the factory's description transformation before publishing", async () => {
    const { steps } = setup();
    await useSteps(steps).deliverChange({
      ...options,
      pullRequestDescription: {
        harness: { kind: "claude", model: "writer" },
        transform: (description, task) => ({
          ...description,
          title: `${task.key}: ${description.title}`,
        }),
      },
    });
    expect(steps.openPullRequest).toHaveBeenCalledWith({
      repo: { owner: "owner", repo: "repo" },
      head: "fix",
      base: "main",
      title: "internal-42: fix: search",
      body: "Fixed and tested",
    });
  });

  it("stops before review when the implementation leaves the worktree dirty", async () => {
    const { steps, calls } = setup();
    vi.mocked(steps.readBranchState).mockResolvedValue({ commits: 1, headSha: "new", dirty: true });
    await expect(useSteps(steps).deliverChange(options)).rejects.toThrow(
      "The implementation left uncommitted changes; only committed work is reviewed. The work is pushed on branch fix",
    );
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
    await expect(useSteps(steps).deliverChange(options)).rejects.toThrow(
      "The implementation added no commits since the base commit. The work is pushed on branch fix",
    );
    expect(calls).toHaveLength(1);
    expect(steps.pushBranch).toHaveBeenCalledWith("/work", "fix");
  });

  it("records the reviewed commit and shows it to the reviewer", async () => {
    const { steps, calls } = setup();
    vi.mocked(steps.readBranchState).mockResolvedValue({
      commits: 2,
      headSha: "reviewed",
      dirty: false,
    });
    const built = await useSteps(steps).implementAndReview({
      ...options,
      limits: { implementationReviewRounds: 1 },
    });
    expect(built).toMatchObject({
      change: { approval: { reviewedCommit: "reviewed" } },
    });
    expect(calls[1]?.prompt).toContain("Head commit under review: reviewed");
  });

  it("does not open a PR when the durable approval check rejects publication", async () => {
    const { steps, calls } = setup();
    vi.mocked(steps.pushApprovedChange).mockRejectedValue(new Error("Unapproved work"));
    await expect(useSteps(steps).publishApprovedChange(publish)).rejects.toThrow("Unapproved work");
    expect(steps.openPullRequest).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("publishes the approved commit without an implementation agent turn", async () => {
    const { steps, calls } = setup();
    expect(await useSteps(steps).publishApprovedChange(publish)).toEqual(pr);
    expect(steps.pushApprovedChange).toHaveBeenCalledExactlyOnceWith("/work", "fix", "new");
    expect(steps.readBranchState).not.toHaveBeenCalled();
    expect(steps.pushBranch).not.toHaveBeenCalled();
    expect(steps.openPullRequest).toHaveBeenCalledWith({
      repo: { owner: "owner", repo: "repo" },
      head: "fix",
      base: "main",
      title: "fix: search",
      body: "Fixed and tested",
    });
    expect(steps.registerResource).toHaveBeenCalledWith({
      kind: "pull-request",
      identity: "owner/repo#1",
      url: "https://github.com/owner/repo/pull/1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("Write a concise");
  });

  it("keeps pull-request creation separate when resource registration fails", async () => {
    const { steps } = setup();
    vi.mocked(steps.registerResource).mockRejectedValue(new Error("attribute write failed"));

    await expect(useSteps(steps).publishApprovedChange(publish)).rejects.toThrow(
      "attribute write failed",
    );

    expect(steps.openPullRequest).toHaveBeenCalledOnce();
    expect(steps.registerResource).toHaveBeenCalledOnce();
  });
  it("lets a factory retain its own task fields and use them in prompt functions", async () => {
    const { steps, calls } = setup();
    const incident = {
      ...options.task,
      key: "overnight audit / storage",
      service: "bucket-a",
      impact: "unexpected growth",
    };
    const result = await useSteps(steps).deliverChange({
      ...options,
      task: incident,
      implementation: {
        harness: options.implementation.harness,
        prompt: ({ task }) =>
          `${task.instructions}\nInvestigate ${incident.service}: ${incident.impact}`,
      },
    });
    expect(result.pr).toEqual(pr);
    expect(calls[0]?.prompt).toContain("bucket-a: unexpected growth");
    expect(result.change.task.key).toBe("overnight audit / storage");
  });
  it("ignores an old CI failure after a revision has moved the branch", async () => {
    const { steps, calls } = setup([red("old"), { kind: "closed", merged: true }]);
    const result = await useSteps(steps).deliverChange(options);
    expect(result.change.attempts.ciFixAttempts).toBe(0);
    expect(calls).toHaveLength(3);
  });

  it("merges the ready commit the wake named", async () => {
    const { steps } = setup([mergeReady("new")]);
    const result = await useSteps(steps).deliverChange({ ...options, merge: JIGS_MERGE });
    expect(result.pr).toEqual(pr);
    expect(steps.mergePullRequest).toHaveBeenCalledExactlyOnceWith(pr, "new", JIGS_MERGE);
  });
  it("lets a role add to the prompt jigs would have sent", async () => {
    const { steps, calls } = setup();
    await useSteps(steps).deliverChange({
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
    await useSteps(steps).deliverChange({
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
    const result = useSteps(steps).implementAndReview({
      ...options,
      implementation: { ...options.implementation, prompt: () => "Follow TASK.md" },
    });
    await expect(result).rejects.toThrow("The work is pushed on branch fix");
    expect(calls[0]?.prompt).toBe("Follow TASK.md");
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
      if (role === "ciRepair") {
        vi.mocked(steps.readBranchState)
          .mockResolvedValueOnce({ commits: 1, headSha: "first", dirty: false })
          .mockResolvedValue({ commits: 2, headSha: "second", dirty: false });
      } else {
        vi.mocked(steps.readBranchState).mockResolvedValue({
          commits: 1,
          headSha: "first",
          dirty: false,
        });
      }
      await useSteps(steps).followPullRequest({
        change: { ...approved, attempts: { ...approved.attempts }, sessions: {}, review: [] },
        pr,
        implementation: options.implementation,
        postNote: options.postNote,
        [role]: { ...options.implementation, prompt: () => "Follow TASK.md" },
        limits: { ciFixAttempts: 1, pullRequestRevisionRounds: 1 },
        merge: HUMAN_MERGE,
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
    await useSteps(steps).followPullRequest({
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
      postNote: options.postNote,
      ciRepair: { ...options.implementation, prompt: () => "Follow TASK.md" },
      limits: { ciFixAttempts: 1, pullRequestRevisionRounds: 1 },
      merge: HUMAN_MERGE,
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
    await expect(
      useSteps(steps).implementAndReview({
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
      }),
    ).rejects.toThrow("The work is pushed on branch fix");
    expect(steps.readWorktreeDiff).toHaveBeenCalledExactlyOnceWith("/work", "base");
    expect(calls[0]?.prompt).toContain("Current diff:\ndiff");
  });

  it("sends each role the shipped default when it supplies no prompt", async () => {
    const { steps, calls } = setup();
    const shared = { task: options.task, worktree: options.worktree };
    const renderDefaultPrompt = async () => "";
    await useSteps(steps).deliverChange(options);
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
        responses: [],
        ledger: [],
        renderDefaultPrompt,
      }),
    );
    expect(calls[2]?.prompt).toBe(
      defaultDescriptionPrompt({ ...shared, diff: "diff", renderDefaultPrompt }),
    );
  });

  it("still validates structured output when a role replaces the prompt", async () => {
    const { steps } = setup();
    const original = steps.runAgent;
    steps.runAgent = (async (config) =>
      wants(config.output, reviewVerdict)
        ? { text: "", output: reviewVerdict.parse({ verdict: "yes" }) }
        : original(config)) as RunAgentFn;
    await expect(
      useSteps(steps).deliverChange({
        ...options,
        review: { harness: options.review.harness, prompt: () => "Say yes or no." },
      }),
    ).rejects.toThrow();
  });

  it("keeps a custom task's own fields on the limit callback", async () => {
    const { steps } = setup();
    steps.runAgent = (async (config) => ({
      text: "",
      output: wants(config.output, implementationReport) ? { responses: [] } : blocking("Test"),
    })) as RunAgentFn;
    const incident = { ...options.task, service: "bucket-a", impact: "unexpected growth" };
    const seen: string[] = [];
    await expect(
      useSteps(steps).deliverChange({
        ...options,
        task: incident,
        onLimit: async (limit) => {
          seen.push(`${limit.task.service}: ${limit.task.impact}`);
          return { action: "stop" };
        },
      }),
    ).rejects.toThrow("The work is pushed on branch fix");
    expect(seen).toEqual(["bucket-a: unexpected growth"]);
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
    await useSteps(steps).followPullRequest({
      change: { ...approved, attempts: { ...approved.attempts }, sessions: {}, review: [] },
      pr,
      implementation: options.implementation,
      postNote: options.postNote,
      limits: { ciFixAttempts: 1, pullRequestRevisionRounds: 1 },
      merge: HUMAN_MERGE,
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
      change: { ...approved, attempts: { ...approved.attempts }, sessions, review: [] },
      pr,
      implementation: options.implementation,
      postNote: options.postNote,
      limits: { ciFixAttempts: 1, pullRequestRevisionRounds: 1 },
      merge: HUMAN_MERGE,
    });
    const branchStates = (steps: DeliverySteps) =>
      vi
        .mocked(steps.readBranchState)
        .mockResolvedValueOnce({ commits: 1, headSha: "first", dirty: false })
        .mockResolvedValueOnce({ commits: 2, headSha: "second", dirty: false });

    const resumed = setup([red("first"), { kind: "closed", merged: true }]);
    branchStates(resumed.steps);
    await useSteps(resumed.steps).followPullRequest(
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
    await useSteps(rebuilt.steps).followPullRequest(follow({}));
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

describe("role sessions across harness changes", () => {
  const source = { apiKeyEnv: "OPENROUTER_API_KEY", model: "vendor/model", kind: "openrouter" };
  const pi = harnesses.pi(models.openrouter("vendor/model"), { thinking: "low" });

  async function repairWith(saved: Harness, current: Harness) {
    const { steps, calls } = setup([red("first"), { kind: "closed", merged: true }]);
    vi.mocked(steps.readBranchState)
      .mockResolvedValueOnce({ commits: 1, headSha: "first", dirty: false })
      .mockResolvedValueOnce({ commits: 2, headSha: "second", dirty: false });
    await useSteps(steps).followPullRequest({
      change: {
        ...approved,
        attempts: { ...approved.attempts },
        sessions: { ciRepair: { harness: saved, session: { harness: saved.kind, id: "saved" } } },
        review: [],
      },
      pr,
      implementation: options.implementation,
      postNote: options.postNote,
      ciRepair: { harness: current },
      limits: { ciFixAttempts: 1, pullRequestRevisionRounds: 1 },
      merge: HUMAN_MERGE,
    });
    return calls[0]?.resume;
  }

  it("resumes a Pi role whose descriptor lists the same fields in another order", async () => {
    const reordered = { thinking: "low", model: source, kind: "pi" } as Harness;
    expect(await repairWith(pi, reordered)).toEqual({ harness: "pi", id: "saved" });
  });

  it("starts a Pi role fresh when its nested model source changes", async () => {
    const other = harnesses.pi(models.openrouter("vendor/other"), { thinking: "low" });
    expect(await repairWith(pi, other)).toBeUndefined();
    const otherKey = harnesses.pi(models.openrouter("vendor/model", { apiKeyEnv: "TEAM_KEY" }), {
      thinking: "low",
    });
    expect(await repairWith(pi, otherKey)).toBeUndefined();
  });

  it("starts a role fresh when it moves to a different harness kind", async () => {
    expect(await repairWith(pi, harnesses.codex("builder"))).toBeUndefined();
  });
});
