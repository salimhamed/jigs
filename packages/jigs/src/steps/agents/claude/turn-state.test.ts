import { expect, test } from "vitest";
import type { ConversationMessage } from "../../../workflow/agents/conversation.ts";
import {
  RESTART_NOTE,
  startTurn,
  step,
  type TurnAction,
  type TurnInput,
  type TurnStart,
  type TurnStep,
} from "./turn-state.ts";

const message = (uuid: string, author = "Salim Hamed"): ConversationMessage => ({
  uuid,
  author,
  text: `text ${uuid}`,
});

const open = (fields: Partial<TurnStart> = {}) =>
  startTurn({ messages: [message("m1")], transcript: new Set(), note: "note", ...fields });

// Feeds inputs in order; `actions` holds what the last one asked for.
function feed(first: TurnStep, ...inputs: TurnInput[]): TurnStep {
  let current = first;
  for (const input of inputs) current = step(current.state, input);
  return current;
}

const launched = (fields: Partial<TurnStart> = {}) =>
  feed(open(fields), { type: "ready" }, { type: "launch" });

const result = (uuids: string[] | undefined, answer = "answer"): TurnInput => ({
  type: "result",
  uuids,
  answer,
});
const inject = (uuid: string): TurnInput => ({ type: "inject", message: message(uuid) });
const finished = (actions: TurnAction[]) => actions.find((action) => action.type === "finish");

test("a fresh turn sends each message under its author, led by the instructions", () => {
  const { state, actions } = open({
    messages: [message("m1"), message("m2", "Ada Lovelace")],
    instructions: "Be brief.",
  });
  expect(actions).toEqual([
    { type: "send", uuid: "m1", text: "Be brief.\n\nSalim Hamed: text m1" },
    { type: "send", uuid: "m2", text: "Ada Lovelace: text m2" },
  ]);
  expect(state).toMatchObject({ resume: false, pending: ["m1", "m2"], consumed: [] });
});

test("a resumed turn leaves the instructions out", () => {
  const { state, actions } = open({ transcript: new Set(["earlier"]), instructions: "Be brief." });
  expect(actions).toEqual([{ type: "send", uuid: "m1", text: "Salim Hamed: text m1" }]);
  expect(state.resume).toBe(true);
});

test("a replay sends the restart note and only what Claude has not seen", () => {
  const opened = open({ messages: [message("m1"), message("m2")], transcript: new Set(["m1"]) });
  expect(opened.actions).toEqual([
    { type: "send", uuid: "note", text: RESTART_NOTE },
    { type: "send", uuid: "m2", text: "Salim Hamed: text m2" },
  ]);
  const done = feed(opened, { type: "launch" }, result(["note", "m2"]));
  expect(finished(done.actions)).toEqual({
    type: "finish",
    result: { outcome: "finished", replies: ["answer"], consumed: ["m1", "m2"] },
  });
});

test("the turn reports its start and launches", () => {
  const ready = step(open({ transcript: new Set(["earlier"]) }).state, { type: "ready" });
  expect(ready.actions).toEqual([{ type: "observe", event: { type: "start", resume: true } }]);
  expect(step(ready.state, { type: "launch" }).actions).toEqual([{ type: "launch" }]);
});

test("an injected message is sent once; a repeat is accepted without sending", () => {
  const first = step(launched().state, inject("m2"));
  expect(first.actions).toEqual([
    { type: "accept" },
    { type: "send", uuid: "m2", text: "Salim Hamed: text m2" },
  ]);
  expect(step(first.state, inject("m2")).actions).toEqual([{ type: "accept" }]);
  expect(step(first.state, inject("m1")).actions).toEqual([{ type: "accept" }]);
});

test("the last answer closes before it is reported, then finishes", () => {
  expect(step(launched().state, result(["m1"])).actions).toEqual([
    { type: "close" },
    { type: "observe", event: { type: "reply", text: "answer" } },
    {
      type: "finish",
      result: { outcome: "finished", replies: ["answer"], consumed: ["m1"] },
    },
  ]);
});

test("an answer with messages still pending waits for the follow-up", () => {
  const first = feed(launched(), inject("m2"), result(["m1"], "first"));
  expect(first.actions).toEqual([{ type: "observe", event: { type: "reply", text: "first" } }]);
  const second = step(first.state, result(["m2"], "second"));
  expect(finished(second.actions)).toEqual({
    type: "finish",
    result: { outcome: "finished", replies: ["first", "second"], consumed: ["m1", "m2"] },
  });
});

test("an ending turn refuses messages", () => {
  const ended = feed(launched(), result(["m1"]));
  expect(step(ended.state, inject("m2")).actions).toEqual([]);
  const stopping = feed(launched(), { type: "stop" });
  expect(step(stopping.state, inject("m2")).actions).toEqual([]);
});

test("stop before launch takes back the input and never launches", () => {
  const stopping = feed(open(), { type: "ready" }, { type: "stop" });
  expect(stopping.actions).toEqual([{ type: "take-back" }]);
  const after = feed(stopping, { type: "withdrawn", uuids: ["m1"] }, { type: "launch" });
  expect(after.actions).toEqual([
    { type: "close" },
    { type: "clear-backstop" },
    { type: "finish", result: { outcome: "stopped", replies: [], consumed: [] } },
  ]);
});

test("stop once launched takes back, interrupts and starts the backstop, once", () => {
  const stopping = step(launched().state, { type: "stop" });
  expect(stopping.actions).toEqual([
    { type: "take-back" },
    { type: "interrupt" },
    { type: "start-backstop" },
  ]);
  expect(step(stopping.state, { type: "stop" }).actions).toEqual([]);
});

test("stop while Claude Code starts up ends once the receipt cancels the first messages", () => {
  const done = feed(
    launched(),
    { type: "stop" },
    { type: "withdrawn", uuids: [] },
    { type: "receipt", cancelled: ["m1"] },
  );
  expect(finished(done.actions)).toEqual({
    type: "finish",
    result: { outcome: "stopped", replies: [], consumed: [] },
  });
});

test("stop between an answer and its queued follow-up ends once the follow-up is cancelled", () => {
  const done = feed(
    launched(),
    inject("m2"),
    result(["m1"], "first"),
    { type: "stop" },
    { type: "withdrawn", uuids: [] },
    { type: "receipt", cancelled: ["m2"] },
  );
  expect(finished(done.actions)).toEqual({
    type: "finish",
    result: { outcome: "stopped", replies: ["first"], consumed: ["m1"] },
  });
});

test("a stop that leaves the running turn waits for its interrupted result", () => {
  const waiting = feed(
    launched(),
    inject("m2"),
    { type: "stop" },
    { type: "withdrawn", uuids: [] },
    { type: "receipt", cancelled: ["m2"] },
  );
  expect(waiting.actions).toEqual([]);
  const done = step(waiting.state, { type: "result", uuids: ["m1"], failure: "interrupted" });
  expect(finished(done.actions)).toEqual({
    type: "finish",
    result: { outcome: "stopped", replies: [], consumed: ["m1"] },
  });
});

test("a stop with no receipt ends at the backstop", () => {
  const deaf = feed(launched(), { type: "stop" }, { type: "receipt", cancelled: undefined });
  expect(deaf.actions).toEqual([]);
  expect(finished(step(deaf.state, { type: "backstop" }).actions)).toMatchObject({
    result: { outcome: "stopped" },
  });
  expect(
    finished(feed(launched(), { type: "stop" }, { type: "interrupt-failed" }).actions),
  ).toMatchObject({ result: { outcome: "stopped" } });
});

test("a backstop after the turn ended does nothing", () => {
  expect(feed(launched(), result(["m1"]), { type: "backstop" }).actions).toEqual([]);
});

test("a result that names no messages, or as many as the cap, takes everything sent", () => {
  const missing = feed(launched(), inject("m2"), result(undefined));
  expect(finished(missing.actions)).toMatchObject({ result: { consumed: ["m1", "m2"] } });

  const many = Array.from({ length: 64 }, (_, i) => `x${i}`);
  const capped = feed(launched(), inject("m2"), result(["m1", ...many]));
  expect(finished(capped.actions)).toMatchObject({ result: { consumed: ["m1", "m2"] } });
});

test("a failed turn keeps the answers and messages before it, naming its error", () => {
  const done = feed(
    launched(),
    inject("m2"),
    result(["m1"], "first"),
    { type: "assistant", error: "rate_limit" },
    { type: "result", uuids: ["m2"], failure: "too many" },
  );
  expect(finished(done.actions)).toEqual({
    type: "finish",
    result: {
      outcome: "failed",
      error: "Claude Code failed (rate_limit): too many",
      replies: ["first"],
      consumed: ["m1", "m2"],
    },
  });
});

test("a crash before any answer fails the step; after one it keeps the answers", () => {
  const crash: TurnInput = { type: "crashed", message: "process failed", cancelled: false };
  expect(step(launched().state, crash).actions).toEqual([{ type: "close" }, { type: "rethrow" }]);

  const answered = feed(launched(), inject("m2"), result(["m1"], "first"));
  expect(finished(step(answered.state, crash).actions)).toEqual({
    type: "finish",
    result: { outcome: "failed", error: "process failed", replies: ["first"], consumed: ["m1"] },
  });
  expect(step(answered.state, { ...crash, cancelled: true }).actions).toEqual([
    { type: "close" },
    { type: "rethrow" },
  ]);
  const stopping = step(answered.state, { type: "stop" });
  expect(finished(step(stopping.state, crash).actions)).toMatchObject({
    result: { outcome: "stopped" },
  });
});
