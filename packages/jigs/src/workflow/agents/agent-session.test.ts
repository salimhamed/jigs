import { expect, test } from "vitest";
import { z } from "zod";
import { unwrapAgentStep } from "./agent.ts";
import { bindAgentSession, type RunAgentFn } from "./agent-session.ts";
import { type Harness, harnesses, models } from "./harness-config.ts";
import { parseOutput, type RunAgentOptions } from "./plan.ts";
import { type AgentResult, type AgentSessionRef, describeHarness } from "./result.ts";

const verdict = z.strictObject({ note: z.string() });

// A stale resume is staged the way production stages it: the step returns the
// marker and ./agent.ts turns it into the throw, so these cases prove the whole
// chain, not only that the fallback catches what it constructs itself.
function recorder(
  options: {
    staleResume?: boolean;
    session?: (call: number, harness: Harness) => AgentSessionRef | undefined;
  } = {},
) {
  const calls: RunAgentOptions<unknown>[] = [];
  const runAgent: RunAgentFn = async <T>(config: RunAgentOptions<T>) => {
    calls.push(config as RunAgentOptions<unknown>);
    const session =
      options.session?.(calls.length, config.harness) ?? ref(config.harness, `s-${calls.length}`);
    const result = unwrapAgentStep(
      options.staleResume === true && config.resume !== undefined
        ? { resumeFailed: "no rollout found for thread id 0199-gone" }
        : { text: "", output: { note: "done" }, session },
    );
    return { ...result, output: parseOutput(config.output, result.output) } as AgentResult<T>;
  };
  return { calls, runAgent };
}

function ref(harness: Harness, id: string): AgentSessionRef {
  return { harness: harness.kind, id, descriptor: describeHarness(harness) };
}

const turn = { resume: "only what is new", fresh: "everything", output: verdict };

test("the first turn starts fresh and a later turn resumes the session it recorded", async () => {
  const { calls, runAgent } = recorder();
  const session = bindAgentSession(runAgent)({
    name: "builder",
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: "/tmp/worktree",
  });

  expect(await session.run(turn)).toEqual({ note: "done" });
  let freshBuilt = 0;
  await session.run({
    ...turn,
    fresh: async () => {
      freshBuilt += 1;
      return "everything";
    },
  });

  expect(calls.map((call) => [call.prompt, call.resume])).toEqual([
    ["everything", undefined],
    ["only what is new", expect.objectContaining({ harness: "claude", id: "s-1" })],
  ]);
  expect(calls[1]?.cwd).toBe("/tmp/worktree");
  // A fresh prompt gathers its own context (a diff read is a step call), so the
  // resume path must not pay for it.
  expect(freshBuilt).toBe(0);
});

test("the reference is updated after each run", async () => {
  const { calls, runAgent } = recorder();
  const session = bindAgentSession(runAgent)({
    name: "builder",
    harness: harnesses.codex({ model: "gpt" }),
    cwd: "/w",
  });

  await session.run(turn);
  await session.run(turn);
  await session.run(turn);

  expect(calls.map((call) => call.resume)).toEqual([
    undefined,
    expect.objectContaining({ harness: "codex", id: "s-1" }),
    expect.objectContaining({ harness: "codex", id: "s-2" }),
  ]);
});

test("a resumed run that reports no session keeps the reference it resumed", async () => {
  const { calls, runAgent } = recorder({
    session: (call, harness) => (call === 1 ? ref(harness, "kept") : undefined),
  });
  const unreported: RunAgentFn = async <T>(config: RunAgentOptions<T>) => {
    const result = await runAgent(config);
    return calls.length === 1 ? result : { text: "", output: result.output };
  };
  const session = bindAgentSession(unreported)({
    name: "builder",
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: "/w",
  });

  await session.run(turn);
  await session.run(turn);
  await session.run(turn);

  expect(calls[2]?.resume).toEqual(expect.objectContaining({ harness: "claude", id: "kept" }));
});

test("a session the step reports unusable is started fresh, which then holds the work", async () => {
  const { calls, runAgent } = recorder({ staleResume: true });
  const session = bindAgentSession(runAgent)({
    name: "builder",
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: "/w",
  });

  await session.run(turn);
  expect(await session.run(turn)).toEqual({ note: "done" });

  expect(calls.map((call) => [call.prompt, call.resume])).toEqual([
    ["everything", undefined],
    ["only what is new", expect.objectContaining({ harness: "claude", id: "s-1" })],
    ["everything", undefined],
  ]);
});

test("a reference recorded on a different harness kind is not resumed", async () => {
  const { calls, runAgent } = recorder({
    session: (call) => (call === 1 ? ref(harnesses.claude({ model: "sonnet" }), "old") : undefined),
  });
  const session = bindAgentSession(runAgent)({
    name: "builder",
    harness: harnesses.codex({ model: "gpt" }),
    cwd: "/w",
  });

  await session.run(turn);
  await session.run(turn);

  expect(calls).toHaveLength(2);
  expect(calls[1]?.resume).toBeUndefined();
  expect(calls[1]?.prompt).toBe("everything");
});

test("a reference recorded on another descriptor starts fresh; field order alone does not", async () => {
  // What a replay after a redeploy looks like: the first turn's recorded
  // result carries the descriptor the run started on.
  const current = harnesses.pi(models.openrouter("openai/gpt-oss"), { thinking: "high" });
  const secondResume = async (recordedOn: Harness) => {
    const { calls, runAgent } = recorder({
      session: (call) => (call === 1 ? ref(recordedOn, "recorded") : undefined),
    });
    const session = bindAgentSession(runAgent)({ name: "fixer", harness: current, cwd: "/w" });
    await session.run(turn);
    await session.run(turn);
    return calls[1]?.resume;
  };

  expect(
    await secondResume(harnesses.pi(models.openrouter("openai/gpt-5"), { thinking: "high" })),
  ).toBeUndefined();
  const reordered = { thinking: "high", model: { ...current.model }, kind: "pi" } as Harness;
  expect(await secondResume(reordered)).toMatchObject({ harness: "pi", id: "recorded" });
});

test("without output the turn resolves to nothing", async () => {
  const { runAgent } = recorder();
  const session = bindAgentSession(runAgent)({
    name: "fixer",
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: "/w",
  });
  expect(await session.run({ resume: "r", fresh: "f" })).toBeUndefined();
});

test("an error that is not a resume failure is not swallowed", async () => {
  let calls = 0;
  const runAgent: RunAgentFn = async <T>() => {
    calls += 1;
    if (calls > 1) throw new Error("the harness fell over");
    return {
      text: "",
      output: undefined as T,
      session: ref(harnesses.claude({ model: "sonnet" }), "s"),
    };
  };
  const session = bindAgentSession(runAgent)({
    name: "builder",
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: "/w",
  });
  await session.run({ resume: "r", fresh: "f" });
  await expect(session.run({ resume: "r", fresh: "f" })).rejects.toThrow("the harness fell over");
  expect(calls).toBe(2);
});
