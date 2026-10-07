import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LiveTurn } from "../steps/agents/shared/live-turns.ts";
import type { Occurrence } from "./event-triggers/store.ts";
import {
  routeSessionPrompt,
  type SessionPromptDeps,
  STOP_GRACE_MS,
} from "./linear-session-prompts.ts";
import type { WakeOutcome } from "./wake.ts";

const TOKEN = "linear:session:acme:session-1";
const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";

let turn: { inject: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } | undefined;
let wakeOutcome: WakeOutcome;
let rows: Array<Pick<Occurrence, "state" | "runId">>;
let statuses: Map<string, string>;
let answered: boolean;
let timers: Array<() => void>;
let deps: SessionPromptDeps & {
  wake: ReturnType<typeof vi.fn>;
  cancelRun: ReturnType<typeof vi.fn>;
  hookRun: ReturnType<typeof vi.fn>;
};
const posted: Array<{ sessionId: string; body: string }> = [];

beforeEach(() => {
  turn = undefined;
  wakeOutcome = { outcome: "gone" };
  rows = [];
  statuses = new Map();
  answered = false;
  timers = [];
  posted.length = 0;
  deps = {
    liveTurn: (token) => (token === TOKEN ? (turn as LiveTurn | undefined) : undefined),
    wake: vi.fn(async () => wakeOutcome),
    linear: () => ({
      postActivity: async (sessionId, content) => {
        posted.push({ sessionId, body: (content as { body: string }).body });
        return { id: "posted", createdAt: "" };
      },
      answeredSince: async () => answered,
    }),
    appName: async () => "jigs",
    recorded: async () => rows as Occurrence[],
    runStatuses: async () => statuses,
    hookRun: vi.fn(async () => RUN),
    cancelRun: vi.fn(async () => {}),
    later: (fire, ms) => {
      expect(ms).toBe(STOP_GRACE_MS);
      timers.push(fire);
    },
  };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const liveTurn = (accepts = true) => {
  turn = { inject: vi.fn(() => accepts), stop: vi.fn() };
  return turn;
};

let activityCount = 0;
const prompted = (activity: { signal?: string | null; body?: string } = {}) => {
  activityCount += 1;
  return {
    type: "AgentSessionEvent",
    action: "prompted",
    agentSession: { id: "session-1" },
    agentActivity: {
      id: `activity-${activityCount}`,
      createdAt: "2026-10-07T00:00:00.000Z",
      signal: activity.signal ?? null,
      content: { type: "prompt", body: activity.body ?? "and the tests?" },
      user: { id: "u1", name: "Ada" },
      sourceCommentId: activity.signal === "stop" ? undefined : "comment-1",
    },
  };
};

const route = (payload: unknown) => routeSessionPrompt("acme", payload, deps);
const fireTimers = async () => {
  for (const fire of timers.splice(0)) fire();
  await new Promise((resolve) => setImmediate(resolve));
};

test("a reply goes into the live turn, and the session's hook is woken too", async () => {
  const live = liveTurn();
  wakeOutcome = { outcome: "woken" };
  const event = prompted();

  expect(await route(event)).toBe("woken");

  expect(live.inject).toHaveBeenCalledExactlyOnceWith({
    uuid: event.agentActivity.id,
    author: "Ada",
    text: "and the tests?",
  });
  expect(deps.wake).toHaveBeenCalledWith(TOKEN, expect.any(String));
  expect(posted).toEqual([]);
});

test("a reply with no live turn wakes the parked run", async () => {
  wakeOutcome = { outcome: "woken" };
  expect(await route(prompted())).toBe("woken");
  expect(deps.wake).toHaveBeenCalledWith(TOKEN, expect.any(String));
  expect(posted).toEqual([]);
});

test("a reply a live turn takes stands even when no hook is held", async () => {
  liveTurn();
  expect(await route(prompted())).toBe("woken");
  expect(posted).toEqual([]);
});

test("a reply after the session's run ended is told the conversation is over", async () => {
  rows = [{ state: "started", runId: RUN }];
  statuses = new Map([[RUN, "completed"]]);

  expect(await route(prompted())).toBe("dropped");

  expect(posted).toEqual([
    {
      sessionId: "session-1",
      body: "This conversation has ended; mention @jigs again to start a new one.",
    },
  ]);
});

test("without the app's name, the ended message names no one", async () => {
  rows = [{ state: "failed", runId: null }];
  deps.appName = async () => {
    throw new Error("hub down");
  };
  await route(prompted());
  expect(posted[0]?.body).toBe(
    "This conversation has ended; mention the app again to start a new one.",
  );
});

test("a session this factory never ran is left alone", async () => {
  expect(await route(prompted())).toBe("ignored");
  expect(await route(prompted({ signal: "stop", body: "stop" }))).toBe("ignored");
  expect(posted).toEqual([]);
  expect(timers).toEqual([]);
});

test("a reply while the session's run is still starting waits for it to read the session", async () => {
  rows = [{ state: "pending", runId: null }];
  expect(await route(prompted())).toBe("dropped");
  rows = [{ state: "started", runId: RUN }];
  statuses = new Map([[RUN, "running"]]);
  expect(await route(prompted())).toBe("dropped");
  expect(posted).toEqual([]);
});

test("a wake that could not be delivered is routed again", async () => {
  wakeOutcome = { outcome: "failed", error: "db down" };
  expect(await route(prompted())).toBe("failed");
  expect(posted).toEqual([]);
});

test("a signal other than stop is a reply", async () => {
  const live = liveTurn();
  await route(prompted({ signal: "select", body: "Option B" }));
  expect(live.inject).toHaveBeenCalledWith(expect.objectContaining({ text: "Option B" }));
  expect(live.stop).not.toHaveBeenCalled();
});

test("stop interrupts the live turn and wakes the hook; a run that answers is left be", async () => {
  const live = liveTurn();
  wakeOutcome = { outcome: "woken" };

  expect(await route(prompted({ signal: "stop", body: "stop" }))).toBe("woken");

  expect(live.stop).toHaveBeenCalledOnce();
  expect(live.inject).not.toHaveBeenCalled();
  expect(deps.wake).toHaveBeenCalledWith(TOKEN, expect.any(String));
  answered = true;
  await fireTimers();
  expect(deps.cancelRun).not.toHaveBeenCalled();
  expect(posted).toEqual([]);
});

test("a stop a parked run does not answer in time cancels the run and ends the session", async () => {
  wakeOutcome = { outcome: "woken" };

  expect(await route(prompted({ signal: "stop", body: "stop" }))).toBe("woken");
  expect(posted).toEqual([]);
  await fireTimers();

  expect(deps.hookRun).toHaveBeenCalledWith(TOKEN);
  expect(deps.cancelRun).toHaveBeenCalledExactlyOnceWith(RUN);
  expect(posted).toEqual([{ sessionId: "session-1", body: "Stopped." }]);
});

test("a stop routed twice waits once", async () => {
  wakeOutcome = { outcome: "woken" };
  const stop = prompted({ signal: "stop", body: "stop" });
  await route(stop);
  await route(stop);
  expect(timers).toHaveLength(1);
  await fireTimers();
});

test("a stop whose run has already let go of the session only ends it", async () => {
  wakeOutcome = { outcome: "woken" };
  deps.hookRun.mockResolvedValueOnce(null);
  await route(prompted({ signal: "stop", body: "stop" }));
  await fireTimers();
  expect(deps.cancelRun).not.toHaveBeenCalled();
  expect(posted).toEqual([{ sessionId: "session-1", body: "Stopped." }]);
});

test("a stop after the session's run ended is answered at once", async () => {
  rows = [{ state: "started", runId: RUN }];
  statuses = new Map([[RUN, "cancelled"]]);

  expect(await route(prompted({ signal: "stop", body: "stop" }))).toBe("dropped");

  expect(posted).toEqual([{ sessionId: "session-1", body: "Stopped." }]);
  expect(timers).toEqual([]);
});

test("a stop before the session's run reaches its hook still gets the fallback", async () => {
  rows = [{ state: "pending", runId: null }];
  expect(await route(prompted({ signal: "stop", body: "stop" }))).toBe("dropped");
  expect(timers).toHaveLength(1);
  await fireTimers();
  expect(posted).toEqual([{ sessionId: "session-1", body: "Stopped." }]);
});

test("an event that is not a readable prompt is ignored", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(await route({ type: "AgentSessionEvent", action: "prompted" })).toBe("ignored");
  expect(deps.wake).not.toHaveBeenCalled();
});
