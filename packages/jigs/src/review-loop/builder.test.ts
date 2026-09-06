import { beforeEach, expect, test } from "vitest";
import type { ReviewThread } from "../providers/github.ts";
import { type AgentStepConfig, claude, parseOutput } from "../steps/index.ts";
import { resumeFailed } from "../steps/resume.ts";
import type { Handoff } from "../ticket/review.ts";
import type { TicketSnapshot } from "../ticket/snapshot.ts";
import { answerAsBuilder, type BuilderDeps } from "./builder.ts";

const snapshot: TicketSnapshot = {
  fetchedAt: "2026-08-26T13:00:00Z",
  id: "68bc9696-35d5-442d-ab56-214c8cfefbec",
  identifier: "AGE-316",
  title: "Review loop jig",
  description: "## Acceptance criteria\n\n- the builder answers in-thread",
  url: "https://linear.app/x/issue/AGE-316",
  branchName: "salimhamed/age-316-review-loop",
  state: "Todo",
  labels: [],
  comments: [],
  blockedBy: [],
  blocks: [],
  links: [],
  subIssues: [],
};

const handoff: Handoff = { brief: "BRIEF-TEXT: build the gate", snapshot };

const thread = (rootId: number, body: string): ReviewThread => ({
  rootId,
  path: "src/gate.ts",
  line: 12,
  comments: [
    {
      id: rootId,
      rootId,
      body,
      user: "reviewer",
      path: "src/gate.ts",
      line: 12,
      createdAt: "2026-08-26T12:00:00Z",
    },
  ],
});

const threads = [thread(900, "why not a set here?"), thread(910, "typo")];

let agentCalls: AgentStepConfig<unknown>[] = [];
let diffCalls: Array<[string, string]> = [];
let raw: unknown[] = [];
let failOnResume = false;

const fakeAgent: BuilderDeps["agent"] = async <T>(
  config: AgentStepConfig<T>,
) => {
  agentCalls.push(config as AgentStepConfig<unknown>);
  if (failOnResume && config.resume !== undefined) {
    resumeFailed("no rollout found for thread id 0199-gone");
  }
  return {
    text: "",
    output: parseOutput(config.output, raw.shift()),
    usage: undefined,
    session: { harness: "claude" as const, id: `s-${agentCalls.length}` },
  };
};

const fakeReadDiff: BuilderDeps["readDiff"] = async (cwd, baseSha) => {
  diffCalls.push([cwd, baseSha]);
  return "diff --git a/src/gate.ts b/src/gate.ts\n+THE-ACTUAL-DIFF\n";
};

const deps: BuilderDeps = { agent: fakeAgent, readDiff: fakeReadDiff };

const answer = (body: string) => ({
  answers: [{ threadId: 900, body }],
});

const run = (session?: { harness: "claude"; id: string }) =>
  answerAsBuilder(
    {
      harness: claude({ model: "sonnet" }),
      cwd: "/tmp/worktree",
      ...(session === undefined ? {} : { session }),
      threads,
      handoff,
      baseSha: "base-sha-1",
    },
    deps,
  );

beforeEach(() => {
  agentCalls = [];
  diffCalls = [];
  raw = [];
  failOnResume = false;
});

test("a recorded session is resumed rather than rebuilt", async () => {
  raw = [answer("fixed in a2b3c4d")];
  const result = await run({ harness: "claude", id: "s-42" });

  expect(agentCalls).toHaveLength(1);
  expect(agentCalls[0]?.resume).toEqual({ harness: "claude", id: "s-42" });
  const prompt = agentCalls[0]?.prompt ?? "";
  expect(prompt).toContain("Your pull request came back with review comments");
  expect(prompt).toContain("Thread 900");
  expect(prompt).toContain("why not a set here?");
  // The resumed builder holds the context; nothing is re-sent to it.
  expect(prompt).not.toContain("BRIEF-TEXT");
  expect(diffCalls).toEqual([]);
  expect(result.output).toEqual(answer("fixed in a2b3c4d"));
});

test("a stale session falls back to a fresh context that still answers", async () => {
  failOnResume = true;
  raw = [answer("fixed in a2b3c4d")];
  const result = await run({ harness: "claude", id: "s-gone" });

  expect(agentCalls).toHaveLength(2);
  const fresh = agentCalls[1];
  expect(fresh?.resume).toBeUndefined();
  const prompt = fresh?.prompt ?? "";
  expect(prompt).toContain("AGE-316");
  expect(prompt).toContain("BRIEF-TEXT: build the gate");
  expect(prompt).toContain("THE-ACTUAL-DIFF");
  expect(prompt).toContain("why not a set here?");
  expect(prompt).toContain("typo");
  expect(diffCalls).toEqual([["/tmp/worktree", "base-sha-1"]]);
  expect(result.output).toEqual(answer("fixed in a2b3c4d"));
});

test("with no session at all the fresh context is entered directly", async () => {
  raw = [answer("fixed in a2b3c4d")];
  const result = await run();

  expect(agentCalls).toHaveLength(1);
  expect(agentCalls[0]?.resume).toBeUndefined();
  expect(agentCalls[0]?.prompt).toContain("THE-ACTUAL-DIFF");
  // The same schema on both paths is what makes the fallback an equal.
  expect(result.output).toEqual(answer("fixed in a2b3c4d"));
});

test("an error that is not a resume failure is not swallowed", async () => {
  const exploding: BuilderDeps = {
    ...deps,
    agent: async () => {
      throw new Error("the harness fell over");
    },
  };
  await expect(
    answerAsBuilder(
      {
        harness: claude({ model: "sonnet" }),
        cwd: "/tmp/worktree",
        session: { harness: "claude", id: "s-42" },
        threads,
        handoff,
        baseSha: "base-sha-1",
      },
      exploding,
    ),
  ).rejects.toThrow("the harness fell over");
});

test("a review body with no thread of its own is answered on the conversation", async () => {
  raw = [{ answers: [{ threadId: null, body: "addressed all four" }] }];
  const result = await answerAsBuilder(
    {
      harness: claude({ model: "sonnet" }),
      cwd: "/tmp/worktree",
      session: { harness: "claude", id: "s-42" },
      threads: [],
      reviewBody: "four things need fixing",
      handoff,
      baseSha: "base-sha-1",
    },
    deps,
  );

  expect(agentCalls[0]?.prompt).toContain("Thread null");
  expect(agentCalls[0]?.prompt).toContain("four things need fixing");
  expect(result.output.answers[0]?.threadId).toBeNull();
});

test("a malformed answers object fails the schema", async () => {
  raw = [{ answers: [{ threadId: 900, body: "" }] }];
  await expect(run({ harness: "claude", id: "s-42" })).rejects.toThrow();
});
