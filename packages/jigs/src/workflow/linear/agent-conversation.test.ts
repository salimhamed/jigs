import { beforeEach, expect, type Mock, test, vi } from "vitest";
import type { TurnStepResult } from "../agents/conversation.ts";
import type { Harness } from "../agents/harness-config.ts";
import type { LinearAgentConversationSteps } from "./agent-conversation.ts";
import type { LinearAgentPrompt, LinearAgentTurnRequest } from "./agent-session.ts";
import type { LinearAgentSessionInputs } from "./source.ts";

const { createHook, sleep, hook, timer } = vi.hoisted(() => ({
  createHook: vi.fn(),
  sleep: vi.fn(),
  timer: { fire: null as (() => void) | null },
  hook: {
    awaited: 0,
    disposed: 0,
    conflict: null as { runId: string } | null,
    wake: null as (() => void) | null,
  },
}));
vi.mock("workflow", () => ({ createHook, sleep }));

const { linearAgentConversation } = await import("./agent-conversation.ts");

const claude = { kind: "claude", model: "opus" } as Harness;
const SESSION = "5f0c2a8e-7d1b-4c3e-9a6f-1b2c3d4e5f60";
const inputs: LinearAgentSessionInputs = {
  session: SESSION,
  installationName: "acme",
  issue: { id: "i1", identifier: "AGE-1", title: "Fix it", url: "https://linear.app/i/AGE-1" },
  comment: "@jigs please fix the tests",
  promptContext: null,
  creator: { id: "u1", name: "Ada", email: "ada@example.com" },
};
const ref = { installationName: "acme", sessionId: SESSION };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let prompts: LinearAgentPrompt[];
let turnResults: Array<(request: LinearAgentTurnRequest) => TurnStepResult>;
type Steps = LinearAgentConversationSteps;
let steps: { [K in keyof Steps]: Mock<Steps[K]> };

let count = 0;
const prompt = (body: string, signal: string | null = null): LinearAgentPrompt => {
  count += 1;
  return {
    id: `prompt-${count}`,
    createdAt: `2026-10-07T00:00:0${count}.000Z`,
    body,
    signal,
    author: { id: "u2", name: "Grace" },
    sourceCommentId: signal === null ? `comment-${count}` : null,
  };
};

// Like the real step: takes the opening and every unread reply, answers them all.
const answerAll = (request: LinearAgentTurnRequest): TurnStepResult => ({
  outcome: "finished",
  replies: ["done"],
  consumed: [
    ...(request.opening === undefined ? [] : [request.opening.uuid]),
    ...prompts.filter((p) => !request.consumed.includes(p.id)).map((p) => p.id),
  ],
});

beforeEach(() => {
  count = 0;
  prompts = [];
  turnResults = [];
  Object.assign(hook, { awaited: 0, disposed: 0, conflict: null, wake: null });
  timer.fire = null;
  sleep.mockReset();
  sleep.mockImplementation(() => new Promise<void>((fire) => (timer.fire = () => fire())));
  createHook.mockReset();
  createHook.mockImplementation(() => ({
    getConflict: async () => hook.conflict,
    // biome-ignore lint/suspicious/noThenProperty: the SDK's Hook is a thenable
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
      hook.awaited += 1;
      return new Promise<unknown>((wake) => {
        hook.wake = () => wake(undefined);
      }).then(resolve, reject);
    },
    dispose: () => {
      hook.disposed += 1;
    },
  }));
  steps = {
    executeLinearAgentTurn: vi.fn<Steps["executeLinearAgentTurn"]>(async (request) =>
      (turnResults.shift() ?? answerAll)(request),
    ),
    listLinearAgentSessionPrompts: vi.fn<Steps["listLinearAgentSessionPrompts"]>(async () => [
      ...prompts,
    ]),
    postLinearAgentActivity: vi.fn<Steps["postLinearAgentActivity"]>(async () => ({})),
    setLinearAgentSessionUrls: vi.fn<Steps["setLinearAgentSessionUrls"]>(async () => {}),
  };
});

const converse = (options: { idleFor?: "30m" } = {}) =>
  linearAgentConversation(inputs, { harness: claude, cwd: "/w", ...options }, steps);

const parked = async () => {
  await flush();
  expect(hook.wake).not.toBeNull();
};
const wake = async () => {
  const fire = hook.wake;
  hook.wake = null;
  fire?.();
  await flush();
};
const goIdle = async () => {
  timer.fire?.();
  await flush();
};
const posts = () => steps.postLinearAgentActivity.mock.calls.map(([request]) => request);

test("answers the mention, links the run, then ends idle after four hours", async () => {
  const done = converse();
  await parked();
  expect(createHook).toHaveBeenCalledWith({ token: `linear:session:acme:${SESSION}` });
  expect(steps.setLinearAgentSessionUrls).toHaveBeenCalledWith({ ...ref, urls: [] });
  expect(steps.executeLinearAgentTurn).toHaveBeenCalledExactlyOnceWith({
    ...ref,
    harness: claude,
    cwd: "/w",
    consumed: [],
    opening: { uuid: SESSION, author: "Ada", text: "@jigs please fix the tests" },
  });
  expect(sleep).toHaveBeenCalledWith("4h");
  await goIdle();
  expect(await done).toEqual({ outcome: "idle", turns: 1 });
  expect(posts()).toEqual([]);
  expect(hook.disposed).toBe(1);
});

test("a reply after a wake runs a follow-up turn past the cursor, then waits afresh", async () => {
  const done = converse({ idleFor: "30m" });
  await parked();
  const reply = prompt("and the docs?");
  prompts.push(reply);
  await wake();
  expect(steps.executeLinearAgentTurn).toHaveBeenCalledTimes(2);
  expect(steps.executeLinearAgentTurn.mock.calls[1]?.[0]).toEqual({
    ...ref,
    harness: claude,
    cwd: "/w",
    consumed: [SESSION],
  });
  expect(sleep.mock.calls).toEqual([["30m"], ["30m"]]);
  await goIdle();
  expect(await done).toEqual({ outcome: "idle", turns: 2 });
});

test("a wake with nothing new keeps the same idle timer", async () => {
  const done = converse();
  await parked();
  await wake();
  await parked();
  expect(steps.executeLinearAgentTurn).toHaveBeenCalledTimes(1);
  expect(sleep).toHaveBeenCalledTimes(1);
  expect(steps.listLinearAgentSessionPrompts).toHaveBeenCalledTimes(3);
  await goIdle();
  expect(await done).toEqual({ outcome: "idle", turns: 1 });
});

test("a reply no turn took is answered before the run waits, without a wake", async () => {
  const late = prompt("one more thing");
  turnResults.push(() => {
    prompts.push(late);
    return { outcome: "finished", replies: ["done"], consumed: [SESSION] };
  });
  const done = converse();
  await parked();
  expect(hook.awaited).toBe(1);
  expect(steps.executeLinearAgentTurn).toHaveBeenCalledTimes(2);
  expect(steps.executeLinearAgentTurn.mock.calls[1]?.[0].consumed).toEqual([SESSION]);
  await goIdle();
  expect(await done).toEqual({ outcome: "idle", turns: 2 });
});

test("a stop found while parked ends with one Stopped., keyed to the stop", async () => {
  const done = converse();
  await parked();
  const stop = prompt("", "stop");
  prompts.push(stop);
  await wake();
  expect(await done).toEqual({ outcome: "stopped", turns: 1 });
  expect(posts()).toEqual([
    { ...ref, content: { type: "response", body: "Stopped." }, once: `stopped:${stop.id}` },
  ]);
  expect(hook.disposed).toBe(1);
});

test("a stop already in the session ends it before any turn", async () => {
  prompts.push(prompt("wait"), prompt("", "stop"));
  expect(await converse()).toEqual({ outcome: "stopped", turns: 0 });
  expect(steps.executeLinearAgentTurn).not.toHaveBeenCalled();
  expect(posts()).toEqual([
    { ...ref, content: { type: "response", body: "Stopped." }, once: "stopped:prompt-2" },
  ]);
});

test("a stop during a turn ends the conversation once the turn stops", async () => {
  turnResults.push(() => {
    prompts.push(prompt("", "stop"));
    return { outcome: "stopped", replies: [], consumed: [SESSION] };
  });
  expect(await converse()).toEqual({ outcome: "stopped", turns: 1 });
  expect(posts()).toEqual([
    { ...ref, content: { type: "response", body: "Stopped." }, once: "stopped:prompt-1" },
  ]);
  expect(hook.awaited).toBe(0);
});

test("a failed turn posts its error and ends failed", async () => {
  turnResults.push(() => ({
    outcome: "failed",
    error: "Claude crashed",
    replies: [],
    consumed: [],
  }));
  expect(await converse()).toEqual({ outcome: "failed", turns: 0, error: "Claude crashed" });
  expect(posts()).toEqual([{ ...ref, content: { type: "error", body: "Claude crashed" } }]);
});

test("failed checks before a turn post an error and end failed", async () => {
  turnResults.push(
    () =>
      ({
        jitFailure: [{ ok: false, id: "mcp", label: "GitHub MCP", reason: "no token", repair: [] }],
      }) as unknown as TurnStepResult,
  );
  const error = "Claude could not start:\nGitHub MCP: no token";
  expect(await converse()).toEqual({ outcome: "failed", turns: 0, error });
  expect(posts()).toEqual([{ ...ref, content: { type: "error", body: error } }]);
});

const promptContext = '<issue identifier="AGE-1">\n<title>Fix it</title>\n</issue>';

test("Linear's prompt context opens a mention in place of its comment", async () => {
  const done = linearAgentConversation(
    { ...inputs, promptContext },
    { harness: claude, cwd: "/w" },
    steps,
  );
  await parked();
  expect(steps.executeLinearAgentTurn.mock.calls[0]?.[0]).toMatchObject({
    opening: { uuid: SESSION, author: "Ada", text: promptContext },
  });
  await goIdle();
  await done;
});

test("an assignment opens with the assignment, then Linear's prompt context", async () => {
  const done = linearAgentConversation(
    { ...inputs, comment: null, promptContext },
    { harness: claude, cwd: "/w" },
    steps,
  );
  await parked();
  expect(steps.executeLinearAgentTurn.mock.calls[0]?.[0]).toMatchObject({
    opening: { text: `AGE-1 "Fix it" was assigned to you.\n\n${promptContext}` },
  });
  await goIdle();
  await done;
});

test("an assignment without prompt context opens with a plain message", async () => {
  const done = linearAgentConversation(
    { ...inputs, comment: null, creator: null },
    { harness: claude, cwd: "/w", instructions: "Be brief." },
    steps,
  );
  await parked();
  expect(steps.executeLinearAgentTurn.mock.calls[0]?.[0]).toMatchObject({
    instructions: "Be brief.",
    opening: { uuid: SESSION, author: "Someone", text: 'AGE-1 "Fix it" was assigned to you.' },
  });
  await goIdle();
  await done;
});

test("only a Claude harness can converse, and only one run per session", async () => {
  await expect(
    linearAgentConversation(inputs, { harness: { kind: "codex" } as Harness, cwd: "/w" }, steps),
  ).rejects.toThrow("a Linear agent conversation runs on a Claude harness, not codex");
  hook.conflict = { runId: "wrun_OWNER" };
  await expect(converse()).rejects.toThrow("already claimed by run wrun_OWNER");
  expect(steps.executeLinearAgentTurn).not.toHaveBeenCalled();
});

test("a turn step that throws posts an error, then fails the run", async () => {
  turnResults.push(() => {
    throw new Error("step exhausted its retries");
  });
  await expect(converse()).rejects.toThrow("step exhausted its retries");
  expect(posts()).toEqual([
    {
      ...ref,
      content: {
        type: "error",
        body: "The conversation failed: Error: step exhausted its retries",
      },
    },
  ]);
  expect(hook.disposed).toBe(1);
});

test("an error that cannot be posted still fails the run with the original error", async () => {
  steps.listLinearAgentSessionPrompts.mockRejectedValue(new Error("Linear is down"));
  steps.postLinearAgentActivity.mockRejectedValue(new Error("Linear is down too"));
  await expect(converse()).rejects.toThrow("Linear is down");
  expect(steps.postLinearAgentActivity).toHaveBeenCalledTimes(1);
});
