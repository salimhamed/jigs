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
  options: { transcript?: string[]; observe?: (event: TurnEvent) => void } = {},
) {
  const driver = createClaudeDriver({
    query: cli.query,
    transcript: async () => new Set(options.transcript ?? []),
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
    replies: [{ text: "reply 1", consumed: ["m1", "m2"] }],
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
    replies: [
      { text: "reply 1", consumed: ["m1"] },
      { text: "reply 2", consumed: ["m2"] },
    ],
    consumed: ["m1", "m2"],
  });
  expect(cli.calls).toHaveLength(1);
});

test("the live turn refuses messages once the turn has begun to end", async () => {
  const turn = request();
  const cli = fakeClaudeCli();
  const live: { inject?: boolean; found?: unknown } = {};
  const result = await converse(cli, turn, {
    observe: (event) => {
      if (event.type === "start") {
        const handle = liveTurn(turn.conversation);
        // Captured now, used once the turn is ending.
        live.found = handle;
      }
      if (event.type === "reply") {
        live.inject = (live.found as ReturnType<typeof liveTurn>)?.inject(message("late"));
        live.found = liveTurn(turn.conversation);
      }
    },
  });
  expect(live).toEqual({ inject: false, found: undefined });
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
  let handle: ReturnType<typeof liveTurn>;
  const result = await converse(cli, turn, {
    observe: (event) => {
      if (event.type === "start") handle = liveTurn(turn.conversation);
      if (event.type === "reply") handle?.stop();
    },
  });
  expect(result?.outcome).toBe("finished");
  expect(cli.interrupts).toEqual([]);
});

test("a fresh conversation starts its own session, led by the instructions", async () => {
  const turn = request({
    instructions: "You are in a Linear thread.",
    messages: [message("m1", "fix the bug"), message("m2", "and add a test", "Ada Lovelace")],
  });
  const cli = fakeClaudeCli();
  await converse(cli, turn);

  const options = cli.calls[0]?.options;
  expect(options?.sessionId).toBe(conversationSessionId(turn.conversation));
  expect(options?.resume).toBeUndefined();
  expect(cli.received).toEqual([
    { uuid: "m1", text: "You are in a Linear thread.\n\nSalim Hamed: fix the bug" },
    { uuid: "m2", text: "Ada Lovelace: and add a test" },
  ]);
});

test("a conversation with a transcript resumes it and leaves the instructions out", async () => {
  const turn = request({ instructions: "You are in a Linear thread." });
  const cli = fakeClaudeCli();
  await converse(cli, turn, { transcript: ["earlier"] });

  const options = cli.calls[0]?.options;
  expect(options?.resume).toBe(conversationSessionId(turn.conversation));
  expect(options?.sessionId).toBeUndefined();
  expect(cli.received).toEqual([{ uuid: "m1", text: "Salim Hamed: text m1" }]);
});

test("a turn whose message is already in the transcript continues where it got to", async () => {
  const turn = request({ messages: [message("m1"), message("m2")] });
  const cli = fakeClaudeCli();
  const result = await converse(cli, turn, { transcript: ["earlier", "m1"] });

  expect(cli.calls[0]?.options.resume).toBe(conversationSessionId(turn.conversation));
  expect(cli.received.map((m) => m.text)).toEqual([RESTART_NOTE, "Salim Hamed: text m2"]);
  expect(result?.consumed).toEqual(["m1", "m2"]);
  expect(result?.replies).toEqual([{ text: "reply 1", consumed: ["m2"] }]);
});

test("a replayed turn with every message delivered sends only the note", async () => {
  const turn = request();
  const cli = fakeClaudeCli();
  const result = await converse(cli, turn, { transcript: ["m1"] });
  expect(cli.received.map((m) => m.text)).toEqual([RESTART_NOTE]);
  expect(result).toEqual({
    outcome: "finished",
    replies: [{ text: "reply 1", consumed: [] }],
    consumed: ["m1"],
  });
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
    { type: "reply", reply: { text: "reply 1", consumed: ["m1"] } },
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

test("an error result fails the turn and frees the conversation", async () => {
  const turn = request();
  const cli = fakeClaudeCli();
  const failing = {
    ...cli,
    query: (call: Parameters<FakeClaudeCli["query"]>[0]) => {
      const inner = cli.query(call);
      return Object.assign(
        (async function* () {
          for await (const m of inner) {
            if (m.type === "result") {
              yield {
                ...m,
                subtype: "error_max_turns",
                is_error: true,
                errors: ["too many"],
              } as typeof m;
              return;
            }
            yield m;
          }
        })(),
        { interrupt: inner.interrupt },
      );
    },
  };
  await expect(converse(failing, turn)).rejects.toThrow("Claude Code failed: too many");
  expect(liveTurn(turn.conversation)).toBeUndefined();
});
