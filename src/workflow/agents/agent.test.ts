import { expect, test } from "vitest";
import { z } from "zod";
import { type ExecuteAgentStep, JitCheckError, runAgent, unwrapAgentStep } from "./agent.ts";
import { bindAgentSession } from "./agent-session.ts";
import { harnesses } from "./harness-config.ts";
import type { AgentRequest } from "./plan.ts";
import { type AgentSessionRef, describeHarness } from "./result.ts";

test("the resumeFailed marker becomes a throw carrying the provider's own words", () => {
  const detail = "no rollout found for thread id 0199-gone";
  expect(() => unwrapAgentStep({ resumeFailed: detail })).toThrow(detail);
});

test("a step result carrying neither marker passes through untouched", () => {
  const result = { text: "done", output: undefined };
  expect(unwrapAgentStep(result)).toBe(result);
});

const harness = harnesses.claude({ model: "sonnet" });
const verdict = z.strictObject({ note: z.string().min(1) });
const session = (id: string): AgentSessionRef => ({
  harness: "claude",
  id,
  descriptor: describeHarness(harness),
});

const stale = Symbol("the resume the step reports unusable");

// Answers in order; each call records the wire it was sent, as a replay would.
function agent(answers: unknown[], sessions = true) {
  const wires: AgentRequest[] = [];
  const execute: ExecuteAgentStep = async (wire) => {
    wires.push(wire);
    const output = answers[wires.length - 1];
    if (output instanceof Error) throw output;
    if (output === stale) return { resumeFailed: "no rollout found" };
    return sessions
      ? { text: "", output, session: session(`s-${wires.length}`) }
      : { text: "", output };
  };
  return { wires, execute };
}

const options = { harness, cwd: "/w", prompt: "Judge the change.", output: verdict };

test("an invalid answer is sent back to its session with only the reasons", async () => {
  const { wires, execute } = agent([{ note: "" }, { note: "fixed" }]);

  const result = await runAgent(options, execute);

  expect(result.output).toEqual({ note: "fixed" });
  expect(result.session?.id).toBe("s-2");
  expect(wires).toHaveLength(2);
  expect(wires[1]?.resume).toEqual(session("s-1"));
  expect(wires[1]?.prompt).toMatch(/^Your answer was rejected:\n.*note/s);
  expect(wires[1]?.prompt).toContain("Answer again, fixing that.");
  expect(wires[1]?.outputSchema).toEqual(wires[0]?.outputSchema);
});

test("without a session the original prompt is sent again with the reasons", async () => {
  const { wires, execute } = agent([{ note: "" }, { note: "fixed" }], false);

  expect((await runAgent(options, execute)).output).toEqual({ note: "fixed" });
  expect(wires[1]?.resume).toBeUndefined();
  expect(wires[1]?.prompt).toMatch(/^Judge the change\.\n\nYour answer was rejected:\n/);
});

test("a second invalid answer throws its ZodError", async () => {
  const { wires, execute } = agent([{ note: "" }, { wrong: true }]);

  await expect(runAgent(options, execute)).rejects.toBeInstanceOf(z.ZodError);
  expect(wires).toHaveLength(2);
});

test("errors other than an invalid answer are not retried", async () => {
  const crashed = agent([new Error("harness crashed")]);
  await expect(runAgent(options, crashed.execute)).rejects.toThrow("harness crashed");
  expect(crashed.wires).toHaveLength(1);

  let calls = 0;
  const jit: ExecuteAgentStep = async () => {
    calls += 1;
    return { jitFailure: [] };
  };
  await expect(runAgent(options, jit)).rejects.toBeInstanceOf(JitCheckError);
  expect(calls).toBe(1);
});

test("the retry request is deterministic", async () => {
  const first = agent([{ note: "" }, { note: "fixed" }]);
  const replay = agent([{ note: "" }, { note: "fixed" }]);

  await runAgent(options, first.execute);
  await runAgent(options, replay.execute);

  expect(replay.wires).toEqual(first.wires);
});

test("an agent session sends an invalid answer back to the session, not the fresh prompt", async () => {
  const { wires, execute } = agent([{ note: "" }, { note: "fixed" }]);
  const builder = bindAgentSession((config) => runAgent(config, execute))({
    name: "builder",
    harness,
    cwd: "/w",
  });

  expect(await builder.run({ resume: "new", fresh: "everything", output: verdict })).toEqual({
    note: "fixed",
  });
  expect(wires.map((wire) => [wire.prompt.split("\n")[0], wire.resume?.id])).toEqual([
    ["everything", undefined],
    ["Your answer was rejected:", "s-1"],
  ]);
});

test("a session that cannot be resumed for the retry falls back to the original prompt", async () => {
  const { wires, execute } = agent([{ note: "" }, stale, { note: "fixed" }]);

  const result = await runAgent(options, execute);

  expect(result.output).toEqual({ note: "fixed" });
  expect(wires.map((wire) => wire.resume?.id)).toEqual([undefined, "s-1", undefined]);
  expect(wires[2]?.prompt).toMatch(/^Judge the change\.\n\nYour answer was rejected:\n/);
});

test("an agent session's fresh turn falls back without a session and holds the one that answered", async () => {
  const { wires, execute } = agent([{ note: "" }, stale, { note: "fixed" }, { note: "next" }]);
  const builder = bindAgentSession((config) => runAgent(config, execute))({
    name: "builder",
    harness,
    cwd: "/w",
  });

  expect(await builder.run({ resume: "new", fresh: "everything", output: verdict })).toEqual({
    note: "fixed",
  });
  await builder.run({ resume: "new", fresh: "everything", output: verdict });

  expect(wires.map((wire) => [wire.prompt.split("\n")[0], wire.resume?.id])).toEqual([
    ["everything", undefined],
    ["Your answer was rejected:", "s-1"],
    ["everything", undefined],
    ["new", "s-3"],
  ]);
});

test("an agent session's resume turn never goes back to fresh to retry a bad answer", async () => {
  const { wires, execute } = agent([{ note: "ok" }, { note: "" }, stale, stale]);
  const builder = bindAgentSession((config) => runAgent(config, execute))({
    name: "builder",
    harness,
    cwd: "/w",
  });
  const turn = { resume: "new", fresh: "everything", output: verdict };

  await builder.run(turn);
  await expect(builder.run(turn)).rejects.toBeInstanceOf(z.ZodError);

  expect(wires.map((wire) => [wire.prompt.split("\n")[0], wire.resume?.id])).toEqual([
    ["everything", undefined],
    ["new", "s-1"],
    ["Your answer was rejected:", "s-2"],
    ["new", "s-1"],
  ]);
});
