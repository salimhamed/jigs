import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ConversationMessage, TurnRequest } from "../../../workflow/agents/conversation.ts";
import { harnesses } from "../../../workflow/agents/harness-config.ts";
import { liveTurn, registerLiveTurn } from "../shared/live-turns.ts";
import type { TurnEvent } from "../shared/types.ts";
import { conversationSessionId, createClaudeDriver, RESTART_NOTE } from "./driver.ts";
import { deferred, type FakeClaudeCli, fakeClaudeCli } from "./test-fixtures.ts";

beforeEach(() => {
  vi.stubEnv("JIGS_CLAUDE_EXECUTABLE", "/fake/claude");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const message = (uuid: string, text = `text ${uuid}`, author = "Salim Hamed") =>
  ({ uuid, author, text }) satisfies ConversationMessage;

let keys = 0;
function request(fields: Partial<TurnRequest> = {}): TurnRequest {
  keys += 1;
  return {
    harness: harnesses.claude({ model: "haiku" }),
    cwd: "/work",
    conversation: `test:conversation:${keys}`,
    messages: [message("m1")],
    ...fields,
  };
}

function converse(
  cli: FakeClaudeCli,
  turn: TurnRequest,
  options: {
    transcript?: string[];
    observe?: (event: TurnEvent) => void;
    discarded?: string[];
  } = {},
) {
  const driver = createClaudeDriver({
    query: cli.query,
    transcript: async () => new Set(options.transcript ?? []),
    discardSession: async (sessionId) => {
      options.discarded?.push(sessionId);
    },
    openStepStream: () => undefined,
  });
  return driver.converse?.(turn, {
    metadata: { workflowRunId: "wrun_converse" },
    deps: {} as never,
    env: {},
    signal: new AbortController().signal,
    observe: options.observe ?? (() => {}),
  });
}

// Captures the live turn as it starts, for use once it is ending.
function captureLiveTurn(turn: TurnRequest, then: (live: ReturnType<typeof liveTurn>) => void) {
  let live: ReturnType<typeof liveTurn>;
  return (event: TurnEvent) => {
    if (event.type === "start") live = liveTurn(turn.conversation);
    if (event.type === "reply") then(live);
  };
}

test("a message sent mid-turn is folded into the running turn", async () => {
  const hold = deferred();
  const turn = request();
  const cli = fakeClaudeCli({ midTurn: () => hold.promise });
  const running = converse(cli, turn);
  await vi.waitFor(() => expect(cli.received).toHaveLength(1));
  expect(liveTurn(turn.conversation)?.inject(message("m2"))).toBe(true);
  hold.resolve();

  await expect(running).resolves.toEqual({
    outcome: "finished",
    replies: ["reply 1"],
    consumed: ["m1", "m2"],
  });
  expect(cli.calls).toHaveLength(1);
  expect(cli.interrupts).toEqual([]);
});

test("a message that misses the result runs as a follow-up turn in the same step", async () => {
  const turn = request();
  const cli = fakeClaudeCli({
    beforeResult: (n) => {
      if (n === 1) liveTurn(turn.conversation)?.inject(message("m2"));
    },
  });

  await expect(converse(cli, turn)).resolves.toEqual({
    outcome: "finished",
    replies: ["reply 1", "reply 2"],
    consumed: ["m1", "m2"],
  });
  expect(cli.calls).toHaveLength(1);
});

test("the live turn refuses messages once the turn has begun to end", async () => {
  const turn = request();
  const cli = fakeClaudeCli();
  const seen: unknown[] = [];
  const result = await converse(cli, turn, {
    observe: captureLiveTurn(turn, (live) => {
      seen.push(live?.inject(message("late")), liveTurn(turn.conversation));
    }),
  });
  expect(seen).toEqual([false, undefined]);
  expect(result?.consumed).toEqual(["m1"]);
  expect(cli.received.map((m) => m.uuid)).toEqual(["m1"]);
});

test("the same message injected twice reaches Claude once", async () => {
  const hold = deferred();
  const turn = request();
  const cli = fakeClaudeCli({ midTurn: () => hold.promise });
  const running = converse(cli, turn);
  await vi.waitFor(() => expect(cli.received).toHaveLength(1));
  const live = liveTurn(turn.conversation);
  expect(live?.inject(message("m2"))).toBe(true);
  expect(live?.inject(message("m2"))).toBe(true);
  expect(live?.inject(message("m1"))).toBe(true);
  hold.resolve();
  expect((await running)?.consumed).toEqual(["m1", "m2"]);
  expect(cli.received.map((m) => m.uuid)).toEqual(["m1", "m2"]);
});

test("stop interrupts the running turn once and drops the queued messages", async () => {
  const turn = request();
  const cli = fakeClaudeCli({ midTurn: () => new Promise(() => {}) });
  const running = converse(cli, turn);
  await vi.waitFor(() => expect(cli.received).toHaveLength(1));
  const live = liveTurn(turn.conversation);
  live?.inject(message("m2"));
  await vi.waitFor(() => expect(cli.received).toHaveLength(2));
  live?.stop();
  live?.stop();
  expect(live?.inject(message("m3"))).toBe(false);

  await expect(running).resolves.toEqual({ outcome: "stopped", replies: [], consumed: ["m1"] });
  expect(cli.interrupts).toEqual([{ cancelQueued: true }]);
  expect(liveTurn(turn.conversation)).toBeUndefined();
});

test("stop takes back a message Claude has not read yet", async () => {
  const turn = request();
  const cli = fakeClaudeCli({ midTurn: () => new Promise(() => {}) });
  const running = converse(cli, turn);
  await vi.waitFor(() => expect(cli.received).toHaveLength(1));
  const live = liveTurn(turn.conversation);
  live?.inject(message("m2"));
  live?.stop();

  await expect(running).resolves.toEqual({ outcome: "stopped", replies: [], consumed: ["m1"] });
  expect(cli.received.map((m) => m.uuid)).toEqual(["m1"]);
});

test("stop while Claude Code starts up cancels the first messages and ends the turn", async () => {
  const turn = request();
  const cli = fakeClaudeCli({ startup: new Promise(() => {}) });
  const running = converse(cli, turn);
  await vi.waitFor(() => expect(cli.received).toHaveLength(1));
  liveTurn(turn.conversation)?.stop();

  await expect(running).resolves.toEqual({ outcome: "stopped", replies: [], consumed: [] });
  expect(cli.interrupts).toEqual([{ cancelQueued: true }]);
});

test("stop between an answer and the follow-up it queued cancels the follow-up", async () => {
  const turn = request();
  let live: ReturnType<typeof liveTurn>;
  const cli = fakeClaudeCli({
    beforeResult: (n) => {
      if (n === 1) live?.inject(message("m2"));
    },
  });
  const result = await converse(cli, turn, {
    observe: (event) => {
      if (event.type === "start") live = liveTurn(turn.conversation);
      if (event.type === "reply") live?.stop();
    },
  });
  expect(result).toEqual({ outcome: "stopped", replies: ["reply 1"], consumed: ["m1"] });
  expect(cli.interrupts).toEqual([{ cancelQueued: true }]);
});

test("a stop Claude Code never confirms still ends the turn", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const turn = request();
  const cli = fakeClaudeCli({ midTurn: () => new Promise(() => {}), deaf: true });
  const running = converse(cli, turn);
  await vi.waitFor(() => expect(cli.received).toHaveLength(1));
  liveTurn(turn.conversation)?.stop();
  await vi.advanceTimersByTimeAsync(30_000);

  await expect(running).resolves.toEqual({ outcome: "stopped", replies: [], consumed: [] });
});

test("stop before Claude starts launches nothing", async () => {
  const turn = request();
  const cli = fakeClaudeCli();
  const result = await converse(cli, turn, {
    observe: (event) => {
      if (event.type === "start") liveTurn(turn.conversation)?.stop();
    },
  });
  expect(result).toEqual({ outcome: "stopped", replies: [], consumed: [] });
  expect(cli.calls).toEqual([]);
  expect(cli.interrupts).toEqual([]);
});

test("stop after the last answer interrupts nothing and the turn still finishes", async () => {
  const turn = request();
  const cli = fakeClaudeCli();
  const result = await converse(cli, turn, {
    observe: captureLiveTurn(turn, (live) => live?.stop()),
  });
  expect(result?.outcome).toBe("finished");
  expect(cli.interrupts).toEqual([]);
});

test("a follow-up that fails keeps the answers and messages before it", async () => {
  const turn = request();
  const cli = fakeClaudeCli({
    beforeResult: (n) => {
      if (n === 1) liveTurn(turn.conversation)?.inject(message("m2"));
    },
    fail: (n) => n === 2,
  });
  await expect(converse(cli, turn)).resolves.toEqual({
    outcome: "failed",
    error: "Claude Code failed: Reached maximum number of turns (1)",
    replies: ["reply 1"],
    consumed: ["m1", "m2"],
  });
  expect(liveTurn(turn.conversation)).toBeUndefined();
});

test("a first turn that fails is a failed outcome too", async () => {
  const result = await converse(fakeClaudeCli({ fail: () => true }), request());
  expect(result).toMatchObject({ outcome: "failed", replies: [], consumed: ["m1"] });
});

test("a process failure before any answer fails the step", async () => {
  const turn = request();
  await expect(converse(fakeClaudeCli({ crash: () => true }), turn)).rejects.toThrow(
    "Claude Code process failed",
  );
  expect(liveTurn(turn.conversation)).toBeUndefined();
});

test("a process failure after an answer keeps it", async () => {
  const turn = request();
  const cli = fakeClaudeCli({
    beforeResult: (n) => {
      if (n === 1) liveTurn(turn.conversation)?.inject(message("m2"));
    },
    crash: (n) => n === 2,
  });
  await expect(converse(cli, turn)).resolves.toEqual({
    outcome: "failed",
    error: "Claude Code process failed",
    replies: ["reply 1"],
    consumed: ["m1"],
  });
});

test("a result that names no messages counts everything sent as taken", async () => {
  const hold = deferred();
  const turn = request();
  const cli = fakeClaudeCli({ midTurn: () => hold.promise, omitUuids: true });
  const running = converse(cli, turn);
  await vi.waitFor(() => expect(cli.received).toHaveLength(1));
  liveTurn(turn.conversation)?.inject(message("m2"));
  hold.resolve();
  await expect(running).resolves.toEqual({
    outcome: "finished",
    replies: ["reply 1"],
    consumed: ["m1", "m2"],
  });
});

test("a fresh conversation starts its own session, led by the instructions", async () => {
  const turn = request({
    instructions: "You are in a Linear thread.",
    messages: [message("m1", "fix the bug"), message("m2", "and add a test", "Ada Lovelace")],
  });
  const cli = fakeClaudeCli();
  const discarded: string[] = [];
  await converse(cli, turn, { discarded });

  const options = cli.calls[0]?.options;
  const sessionId = conversationSessionId(turn.conversation);
  expect(options?.sessionId).toBe(sessionId);
  expect(options?.resume).toBeUndefined();
  expect(discarded).toEqual([sessionId]);
  expect(cli.received).toEqual([
    { uuid: "m1", text: "You are in a Linear thread.\n\nSalim Hamed: fix the bug" },
    { uuid: "m2", text: "Ada Lovelace: and add a test" },
  ]);
});

test("a conversation with a transcript resumes it and leaves the instructions out", async () => {
  const turn = request({ instructions: "You are in a Linear thread." });
  const cli = fakeClaudeCli();
  const discarded: string[] = [];
  await converse(cli, turn, { transcript: ["earlier"], discarded });

  const options = cli.calls[0]?.options;
  expect(options?.resume).toBe(conversationSessionId(turn.conversation));
  expect(options?.sessionId).toBeUndefined();
  expect(discarded).toEqual([]);
  expect(cli.received).toEqual([{ uuid: "m1", text: "Salim Hamed: text m1" }]);
});

test("a turn whose message is already in the transcript continues where it got to", async () => {
  const turn = request({ messages: [message("m1"), message("m2")] });
  const cli = fakeClaudeCli();
  const result = await converse(cli, turn, { transcript: ["earlier", "m1"] });

  expect(cli.calls[0]?.options.resume).toBe(conversationSessionId(turn.conversation));
  expect(cli.received.map((m) => m.text)).toEqual([RESTART_NOTE, "Salim Hamed: text m2"]);
  expect(result).toEqual({ outcome: "finished", replies: ["reply 1"], consumed: ["m1", "m2"] });
});

test("a replayed turn with every message delivered sends only the note", async () => {
  const cli = fakeClaudeCli();
  const result = await converse(cli, request(), { transcript: ["m1"] });
  expect(cli.received.map((m) => m.text)).toEqual([RESTART_NOTE]);
  expect(result).toEqual({ outcome: "finished", replies: ["reply 1"], consumed: ["m1"] });
});

test("the session id is a UUID fixed by the conversation", () => {
  const id = conversationSessionId("linear:session:acme:abc");
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(conversationSessionId("linear:session:acme:abc")).toBe(id);
  expect(conversationSessionId("linear:session:acme:abd")).not.toBe(id);
});

test("the turn reports its start, its activity and each answer", async () => {
  const events: TurnEvent[] = [];
  await converse(fakeClaudeCli(), request(), { observe: (event) => events.push(event) });
  expect(events).toEqual([
    { type: "start", resume: false },
    { type: "part", part: expect.objectContaining({ type: "tool-call", toolName: "Bash" }) },
    { type: "reply" },
  ]);
});

test("a second turn on a live conversation fails before launching", async () => {
  const turn = request();
  const unregister = registerLiveTurn(turn.conversation, { inject: () => true, stop: () => {} });
  const cli = fakeClaudeCli();
  try {
    await expect(converse(cli, turn)).rejects.toThrow("already has a live turn");
  } finally {
    unregister();
  }
  expect(cli.calls).toEqual([]);
});
