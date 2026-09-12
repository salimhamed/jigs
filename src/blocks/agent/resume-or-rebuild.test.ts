import { expect, test } from "vitest";
import { z } from "zod";
import { unwrapAgentStep } from "./agent.ts";
import { claude } from "./harness-config.ts";
import { type AgentStepConfig, parseOutput } from "./plan.ts";
import type { AgentStepResult } from "./result.ts";
import { type AgentFn, resumeOrRebuild } from "./resume-or-rebuild.ts";

const verdict = z.strictObject({ note: z.string() });

// A stale resume is staged the way production stages it — the step returns the
// marker, ./agent.ts turns it into the throw — so these cases prove the whole
// chain, not just that the fallback catches what it itself constructs.
function recorder(options: { staleResume?: boolean } = {}) {
  const calls: AgentStepConfig<unknown>[] = [];
  const agent: AgentFn = async <T>(config: AgentStepConfig<T>) => {
    calls.push(config as AgentStepConfig<unknown>);
    const result = unwrapAgentStep(
      options.staleResume === true && config.resume !== undefined
        ? { resumeFailed: "no rollout found for thread id 0199-gone" }
        : {
            text: "",
            output: { note: "done" },
            session: { harness: "claude" as const, id: `s-${calls.length}` },
          },
    );
    return {
      ...result,
      output: parseOutput(config.output, result.output),
    } as AgentStepResult<T>;
  };
  return { calls, agent };
}

const base = {
  harness: claude({ model: "sonnet" }),
  cwd: "/tmp/worktree",
  label: "test",
  resumePrompt: "you already hold the change",
  output: verdict,
};

test("a live session is resumed and the fresh prompt is never built", async () => {
  const { calls, agent } = recorder();
  let built = 0;
  const result = await resumeOrRebuild({
    ...base,
    agent,
    session: { harness: "claude", id: "s-42" },
    freshPrompt: async () => {
      built += 1;
      return "here is everything";
    },
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.resume).toEqual({ harness: "claude", id: "s-42" });
  // A fresh prompt gathers its own context — a diff read is a step call — so
  // the resume path must not pay for it.
  expect(built).toBe(0);
  expect(result.output).toEqual({ note: "done" });
  // The resumed agent worked inside the pointer it was handed, so the run's
  // own pointer is still the current one.
  expect(result.session).toBeUndefined();
});

test("an unusable session falls back to the fresh context, which then holds the change", async () => {
  const { calls, agent } = recorder({ staleResume: true });
  const result = await resumeOrRebuild({
    ...base,
    agent,
    session: { harness: "claude", id: "s-gone" },
    freshPrompt: "here is everything",
  });

  expect(calls).toHaveLength(2);
  expect(calls[1]?.resume).toBeUndefined();
  expect(calls[1]?.prompt).toBe("here is everything");
  expect(result.output).toEqual({ note: "done" });
  expect(result.session).toEqual({ harness: "claude", id: "s-2" });
});

test("with no session at all the fresh context is entered directly", async () => {
  const { calls, agent } = recorder();
  const result = await resumeOrRebuild({
    ...base,
    agent,
    freshPrompt: "here is everything",
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.resume).toBeUndefined();
  expect(result.session).toEqual({ harness: "claude", id: "s-1" });
});

test("an error that is not a resume failure is not swallowed", async () => {
  const agent: AgentFn = async () => {
    throw new Error("the harness fell over");
  };
  await expect(
    resumeOrRebuild({
      ...base,
      agent,
      session: { harness: "claude", id: "s-42" },
      freshPrompt: "here is everything",
    }),
  ).rejects.toThrow("the harness fell over");
});
