import { afterEach, beforeEach, expect, type Mock, test, vi } from "vitest";
import type { TurnResult } from "../../workflow/agents/conversation.ts";
import type { Harness } from "../../workflow/agents/harness-config.ts";
import type { LinearAgentPrompt } from "../../workflow/linear/agent-session.ts";
import type { TurnObserver } from "../agents/shared/types.ts";
import { executeLinearAgentTurn, type LinearAgentTurnDeps, STATUS_EVERY_MS } from "./agent-turn.ts";

const claude = { kind: "claude", model: "opus" } as Harness;
const metadata = { workflowRunId: "wrun_01", workflowName: "chat", stepId: "step_01" };
const opening = { uuid: "session-1", author: "Ada", text: "fix the tests" };
const base = { installationName: "acme", sessionId: "session-1", harness: claude, cwd: "/w" };
const finished: TurnResult = { outcome: "finished", replies: [], consumed: ["session-1"] };

const prompt = (id: string, body: string, signal: string | null = null): LinearAgentPrompt => ({
  id,
  createdAt: "2026-10-07T00:00:00.000Z",
  body,
  signal,
  author: { id: "u2", name: "Grace" },
  sourceCommentId: null,
});

let prompts: LinearAgentPrompt[];
let observe: TurnObserver;
let endTurn: (result: TurnResult) => void;
type Api = ReturnType<LinearAgentTurnDeps["linear"]>;
let api: { [K in keyof Api]: Mock<Api[K]> };
let deps: LinearAgentTurnDeps & { executeTurn: Mock<LinearAgentTurnDeps["executeTurn"]> };

beforeEach(() => {
  vi.useFakeTimers();
  prompts = [];
  api = {
    listPrompts: vi.fn<Api["listPrompts"]>(async () => [...prompts]),
    postActivity: vi.fn<Api["postActivity"]>(async () => ({ id: "t", createdAt: "" })),
    postActivityOnce: vi.fn<Api["postActivityOnce"]>(async () => ({ id: "r", createdAt: "" })),
  };
  deps = {
    executeTurn: vi.fn<LinearAgentTurnDeps["executeTurn"]>(
      (_request, _metadata, observers = []) => {
        observe = (event) => {
          for (const observer of observers) void observer(event);
        };
        return new Promise<TurnResult>((resolve) => {
          endTurn = resolve;
        });
      },
    ),
    linear: () => api,
    wait: async () => {},
  };
});

afterEach(() => {
  vi.useRealTimers();
});

const settle = () => vi.advanceTimersByTimeAsync(0);
const thoughts = () =>
  api.postActivity.mock.calls.map(([, content]) => ("body" in content ? content.body : ""));

test("a turn takes the opening and every reply past the cursor, keyed to the session", async () => {
  prompts = [prompt("p1", "old"), prompt("p2", "and the docs?")];
  const turn = executeLinearAgentTurn(
    { ...base, opening, consumed: ["p1"], instructions: "Be brief." },
    metadata,
    deps,
  );
  await settle();
  endTurn(finished);
  expect(await turn).toEqual(finished);
  expect(deps.executeTurn).toHaveBeenCalledWith(
    {
      harness: claude,
      cwd: "/w",
      conversation: "linear:session:acme:session-1",
      messages: [opening, { uuid: "p2", author: "Grace", text: "and the docs?" }],
      instructions: "Be brief.",
    },
    metadata,
    [expect.any(Function)],
  );
});

test("a stop past the cursor stops the turn before it starts", async () => {
  prompts = [prompt("p1", "more"), prompt("p2", "", "stop")];
  expect(await executeLinearAgentTurn({ ...base, consumed: [] }, metadata, deps)).toEqual({
    outcome: "stopped",
    replies: [],
    consumed: [],
  });
  expect(deps.executeTurn).not.toHaveBeenCalled();
});

test("the status line names the last tool, changes at most every five seconds, and goes quiet after an answer", async () => {
  const turn = executeLinearAgentTurn({ ...base, opening, consumed: [] }, metadata, deps);
  await settle();
  observe({ type: "start", resume: false });
  await settle();
  expect(thoughts()).toEqual(["Working…"]);
  expect(api.postActivity.mock.calls[0]?.[2]).toEqual({ ephemeral: true });

  observe({
    type: "part",
    part: {
      type: "tool-call",
      toolCallId: "1",
      toolName: "Bash",
      input: { command: "pnpm test\nx" },
    },
  });
  observe({
    type: "part",
    part: {
      type: "tool-call",
      toolCallId: "2",
      toolName: "Read",
      input: { file_path: "/w/src/a.ts" },
    },
  });
  await vi.advanceTimersByTimeAsync(STATUS_EVERY_MS);
  expect(thoughts()).toEqual(["Working…", "Working… (last: used Read)"]);
  await vi.advanceTimersByTimeAsync(STATUS_EVERY_MS * 3);
  expect(thoughts()).toHaveLength(2);
  observe({
    type: "part",
    part: {
      type: "tool-call",
      toolCallId: "3",
      toolName: "Bash",
      input: { command: "pnpm test\nx" },
    },
  });
  await vi.advanceTimersByTimeAsync(STATUS_EVERY_MS);
  expect(thoughts().at(-1)).toBe("Working… (last: ran `pnpm test`)");

  observe({ type: "reply", text: "All green." });
  await vi.advanceTimersByTimeAsync(STATUS_EVERY_MS * 100);
  expect(thoughts()).toHaveLength(3);
  expect(api.postActivityOnce).toHaveBeenCalledWith(
    "session-1",
    { type: "response", body: "All green." },
    expect.any(String),
  );
  endTurn(finished);
  await turn;
});

test("an answer is retried under one id, and the turn returns once it is posted", async () => {
  api.postActivityOnce
    .mockRejectedValueOnce(new Error("502"))
    .mockRejectedValueOnce(new Error("502"));
  const turn = executeLinearAgentTurn({ ...base, opening, consumed: [] }, metadata, deps);
  await settle();
  observe({ type: "reply", text: "Done it." });
  endTurn(finished);
  expect(await turn).toEqual(finished);
  const ids = api.postActivityOnce.mock.calls.map(([, , id]) => id);
  expect(ids).toHaveLength(3);
  expect(new Set(ids).size).toBe(1);
});

test("answers are named by run, step and text, so a retried step posts the same answer once", async () => {
  const answerIds = async (texts: string[]) => {
    api.postActivityOnce.mockClear();
    const turn = executeLinearAgentTurn({ ...base, opening, consumed: [] }, metadata, deps);
    await settle();
    for (const text of texts) observe({ type: "reply", text });
    endTurn(finished);
    await turn;
    return api.postActivityOnce.mock.calls.map(([, , id]) => id);
  };
  const first = await answerIds(["yes", "yes", "no"]);
  expect(new Set(first).size).toBe(3);
  expect(await answerIds(["yes"])).toEqual([first[0]]);
});

test("a failing status line never fails the turn", async () => {
  api.postActivity.mockRejectedValue(new Error("rate limited"));
  const turn = executeLinearAgentTurn({ ...base, opening, consumed: [] }, metadata, deps);
  await settle();
  observe({ type: "start", resume: false });
  await vi.advanceTimersByTimeAsync(STATUS_EVERY_MS);
  endTurn(finished);
  expect(await turn).toEqual(finished);
});
