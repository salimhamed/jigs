import { beforeEach, expect, test } from "vitest";
import type { CheckRun } from "../../providers/github.ts";
import type { readDiff } from "../../steps/pull-request/branch.ts";
import { claude } from "../agent/harness-config.ts";
import type { AgentStepConfig } from "../agent/plan.ts";
import { type AgentFn, resumeFailed } from "../agent/resume-or-rebuild.ts";
import { promptRef } from "../agent/testing.ts";
import type { Handoff } from "../ticket/review.ts";
import type { TicketSnapshot } from "../ticket/snapshot.ts";
import { fixCi } from "./fix-ci.ts";

const snapshot: TicketSnapshot = {
  fetchedAt: "2026-08-26T13:00:00Z",
  id: "68bc9696-35d5-442d-ab56-214c8cfefbec",
  identifier: "AGE-316",
  title: "Review loop",
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

const handoff: Handoff = { brief: "THE-BRIEF", snapshot, assumptions: [] };

const failing: CheckRun[] = [
  { name: "test", conclusion: "failure", url: "http://ci.test/1" },
];

let agentCalls: AgentStepConfig<unknown>[] = [];
let diffCalls: Array<[string, string]> = [];
let failOnResume = false;

const fakeAgent: AgentFn = async <T>(config: AgentStepConfig<T>) => {
  agentCalls.push(config as AgentStepConfig<unknown>);
  if (failOnResume && config.resume !== undefined) {
    resumeFailed("no rollout found for thread id 0199-gone");
  }
  return {
    text: "",
    output: undefined as T,
    usage: undefined,
    session: { harness: "claude" as const, id: `s-${agentCalls.length}` },
  };
};

const fakeReadDiff: typeof readDiff = async (cwd, baseSha) => {
  diffCalls.push([cwd, baseSha]);
  return "THE-ACTUAL-DIFF";
};

const run = (session?: { harness: "claude"; id: string }) =>
  fixCi({
    agent: fakeAgent,
    readDiff: fakeReadDiff,
    harness: claude({ model: "sonnet" }),
    cwd: "/tmp/worktree",
    ...(session === undefined ? {} : { session }),
    failing,
    attempt: "2 of 3",
    handoff,
    baseSha: "base-sha-1",
  });

beforeEach(() => {
  agentCalls = [];
  diffCalls = [];
  failOnResume = false;
});

test("the fix runs inside the builder's session rather than context-free", async () => {
  const fixed = await run({ harness: "claude", id: "s-42" });

  expect(agentCalls).toHaveLength(1);
  expect(agentCalls[0]?.resume).toEqual({ harness: "claude", id: "s-42" });
  const ref = promptRef(agentCalls[0]);
  expect(ref.name).toBe("fix-ci");
  expect(ref.data.ATTEMPT).toBe("2 of 3");
  expect(ref.data.CHECKS).toContain("http://ci.test/1");
  // The diff read is a step call; the resumed arm must not pay for it.
  expect(diffCalls).toEqual([]);
  // A resumed fix leaves the builder's pointer where it is.
  expect(fixed.session).toBeUndefined();
});

test("a stale session sends the fix into a fresh context that then holds the change", async () => {
  failOnResume = true;
  const fixed = await run({ harness: "claude", id: "s-gone" });

  expect(agentCalls).toHaveLength(2);
  const fresh = agentCalls[1];
  expect(fresh?.resume).toBeUndefined();
  const ref = promptRef(fresh);
  expect(ref.name).toBe("fix-ci-fresh");
  expect(ref.data.TICKET).toContain("AGE-316");
  expect(ref.data.BRIEF).toContain("THE-BRIEF");
  expect(ref.data.DIFF).toContain("THE-ACTUAL-DIFF");
  expect(ref.data.ATTEMPT).toBe("2 of 3");
  expect(diffCalls).toEqual([["/tmp/worktree", "base-sha-1"]]);
  expect(fixed.session).toEqual({ harness: "claude", id: "s-2" });
});

test("with no session at all the fresh context is entered directly", async () => {
  const fixed = await run();

  expect(agentCalls).toHaveLength(1);
  expect(agentCalls[0]?.resume).toBeUndefined();
  expect(promptRef(agentCalls[0]).data.DIFF).toContain("THE-ACTUAL-DIFF");
  expect(fixed.session).toEqual({ harness: "claude", id: "s-1" });
});

test("an error that is not a resume failure is not swallowed", async () => {
  const boom: AgentFn = async () => {
    throw new Error("harness exploded");
  };
  await expect(
    fixCi({
      agent: boom,
      readDiff: fakeReadDiff,
      harness: claude({ model: "sonnet" }),
      cwd: "/tmp/worktree",
      session: { harness: "claude", id: "s-42" },
      failing,
      attempt: "1 of 3",
      handoff,
      baseSha: "base-sha-1",
    }),
  ).rejects.toThrow("harness exploded");
});
