import { beforeEach, expect, test } from "vitest";
import { claude } from "../agent/harness-config.ts";
import type { AgentStepConfig } from "../agent/plan.ts";
import type { AgentFn } from "../agent/resume-or-rebuild.ts";
import { resumeFailed } from "../agent/resume-or-rebuild.ts";
import { commitWork } from "./commit-work.ts";

let agentCalls: AgentStepConfig<unknown>[] = [];
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

const run = (session?: { harness: "claude"; id: string }) =>
  commitWork({
    agent: fakeAgent,
    harness: claude({ model: "sonnet" }),
    cwd: "/tmp/worktree",
    ...(session === undefined ? {} : { session }),
  });

beforeEach(() => {
  agentCalls = [];
  failOnResume = false;
});

test("the builder that left the work uncommitted is resumed to commit it", async () => {
  const session = await run({ harness: "claude", id: "s-42" });

  expect(agentCalls).toHaveLength(1);
  expect(agentCalls[0]?.resume).toEqual({ harness: "claude", id: "s-42" });
  expect(agentCalls[0]?.prompt).toContain("commit");
  expect(session).toEqual({ harness: "claude", id: "s-1" });
});

test("a stale session commits from a fresh context that then holds the change", async () => {
  failOnResume = true;
  const session = await run({ harness: "claude", id: "s-gone" });

  expect(agentCalls).toHaveLength(2);
  expect(agentCalls[1]?.resume).toBeUndefined();
  // The work is on disk in the cwd, so both arms are asked the same thing.
  expect(agentCalls[1]?.prompt).toBe(agentCalls[0]?.prompt);
  expect(session).toEqual({ harness: "claude", id: "s-2" });
});
