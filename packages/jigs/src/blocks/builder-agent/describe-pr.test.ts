import { beforeEach, expect, test } from "vitest";
import {
  type AgentFn,
  type AgentStepConfig,
  claude,
  parseOutput,
} from "../steps/index.ts";
import { resumeFailed } from "../steps/resume.ts";
import { describePr } from "./describe-pr.ts";
import type { readDiff } from "./pull-request.ts";

let agentCalls: AgentStepConfig<unknown>[] = [];
let diffCalls: Array<[string, string]> = [];
let raw: unknown[] = [];
let failOnResume = false;

const fakeAgent: AgentFn = async <T>(config: AgentStepConfig<T>) => {
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

const fakeReadDiff: typeof readDiff = async (cwd, baseSha) => {
  diffCalls.push([cwd, baseSha]);
  return "THE-ACTUAL-DIFF";
};

const described = { title: "feat: ship it", body: "what changed and why" };

const run = (session?: { harness: "claude"; id: string }) =>
  describePr({
    agent: fakeAgent,
    readDiff: fakeReadDiff,
    harness: claude({ model: "opus" }),
    cwd: "/tmp/worktree",
    baseSha: "base-sha-1",
    ...(session === undefined ? {} : { session }),
    resumePrompt: "THE-HOUSE-CONVENTIONS",
    freshPrompt: (diff) => `THE-HOUSE-CONVENTIONS\n\n${diff}`,
  });

beforeEach(() => {
  agentCalls = [];
  diffCalls = [];
  raw = [];
  failOnResume = false;
});

test("the builder that wrote the change is asked to describe it", async () => {
  raw = [described];
  const result = await run({ harness: "claude", id: "s-42" });

  expect(agentCalls).toHaveLength(1);
  expect(agentCalls[0]?.resume).toEqual({ harness: "claude", id: "s-42" });
  expect(agentCalls[0]?.prompt).toBe("THE-HOUSE-CONVENTIONS");
  // The diff read is a step call; the resumed arm must not pay for it.
  expect(diffCalls).toEqual([]);
  expect(result).toEqual(described);
});

test("a session on another harness falls through to the diff-fed prompt", async () => {
  failOnResume = true;
  raw = [described];
  const result = await run({ harness: "claude", id: "s-gone" });

  expect(agentCalls).toHaveLength(2);
  expect(agentCalls[1]?.resume).toBeUndefined();
  expect(agentCalls[1]?.prompt).toContain("THE-ACTUAL-DIFF");
  expect(diffCalls).toEqual([["/tmp/worktree", "base-sha-1"]]);
  expect(result).toEqual(described);
});

test("a description missing a title or a body fails the schema", async () => {
  raw = [{ title: "feat: ship it", body: "" }];
  await expect(run()).rejects.toThrow();
});
