import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { derivedUuid } from "../providers/linear.ts";
import { onceActivityId } from "../providers/linear-agent.ts";
import type { LiveTurn } from "../steps/agents/shared/live-turns.ts";
import { stopAnswerKey } from "../workflow/linear/agent-session.ts";
import type { Occurrence } from "./event-triggers/store.ts";
import {
  routeSessionPrompt,
  type SessionPromptDeps,
  STOP_GRACE_MS,
} from "./linear-session-prompts.ts";
import type { WakeOutcome } from "./wake.ts";

const SESSION = "linear:session:acme:session-1";
const LISTENING = "linear:listening:acme:session-1";
const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
const OTHER_RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKN";

type Row = Pick<
  Occurrence,
  "trigger" | "occurrence" | "state" | "runId" | "attemptedAt" | "inputs"
>;

let turn: { inject: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } | undefined;
let wakeOutcome: WakeOutcome;
let holder: string | null;
let rows: Row[];
let statuses: Map<string, string>;
let answered: boolean;
let last: { type: string; createdAt: string } | null;
let timers: Array<{ fire: () => void; ms: number }>;
let postFailures: number;
let deps: SessionPromptDeps & {
  wake: ReturnType<typeof vi.fn>;
  cancelRun: ReturnType<typeof vi.fn>;
  withdraw: ReturnType<typeof vi.fn>;
  recorded: ReturnType<typeof vi.fn>;
};
// Keyed by the activity id, as Linear keeps them.
const posted = new Map<string, { sessionId: string; body: string }>();

beforeEach(() => {
  turn = undefined;
  wakeOutcome = { outcome: "gone" };
  holder = null;
  rows = [];
  statuses = new Map();
  answered = false;
  last = null;
  timers = [];
  postFailures = 0;
  posted.clear();
  deps = {
    liveTurn: (token) => (token === SESSION ? (turn as LiveTurn | undefined) : undefined),
    wake: vi.fn(async () => wakeOutcome),
    linear: () => ({
      postActivityOnce: async (sessionId, content, id) => {
        if (postFailures > 0) {
          postFailures -= 1;
          throw new Error("Linear is down");
        }
        if (!posted.has(id))
          posted.set(id, { sessionId, body: (content as { body: string }).body });
        return { id, createdAt: "" };
      },
      findActivity: async () => (answered ? { id: "stopped", createdAt: "" } : null),
      lastAppActivity: async () => last,
    }),
    appName: async () => "jigs",
    holder: async (token) => (token === SESSION ? holder : null),
    recorded: vi.fn(async () => rows as Occurrence[]),
    withdraw: vi.fn(async (row: Pick<Occurrence, "trigger" | "occurrence">) => {
      const found = rows.find((candidate) => candidate.occurrence === row.occurrence);
      if (found?.state !== "pending" || found.attemptedAt !== null) return false;
      found.state = "skipped";
      return true;
    }),
    runStatuses: async (ids) => new Map([...statuses].filter(([id]) => ids.includes(id))),
    cancelRun: vi.fn(async () => {}),
    later: (fire, ms) => {
      timers.push({ fire, ms });
    },
  };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const row = (fields: Partial<Row> = {}): Row => ({
  trigger: "mentions",
  occurrence: "session-1",
  state: "started",
  runId: RUN,
  attemptedAt: new Date(),
  inputs: { installationName: "acme", session: "session-1" },
  ...fields,
});

const liveTurn = (accepts = true) => {
  turn = { inject: vi.fn(() => accepts), stop: vi.fn() };
  return turn;
};

let activityCount = 0;
const prompted = (
  activity: { signal?: string | null; body?: string; creatorId?: string | null } = {},
) => {
  activityCount += 1;
  return {
    type: "AgentSessionEvent",
    action: "prompted",
    agentSession: {
      id: "session-1",
      creatorId: activity.creatorId === undefined ? "u1" : activity.creatorId,
    },
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
const stopEvent = () => prompted({ signal: "stop", body: "stop" });

const route = (payload: unknown) => routeSessionPrompt("acme", payload, deps);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const fireNext = async (ms?: number) => {
  const timer = timers.shift();
  if (timer === undefined) throw new Error("no timer armed");
  if (ms !== undefined) expect(timer.ms).toBe(ms);
  timer.fire();
  await settle();
};
const bodies = () => [...posted.values()].map(({ body }) => body);
const stoppedId = (event: ReturnType<typeof prompted>) =>
  onceActivityId(event.agentSession.id, stopAnswerKey(event.agentActivity.id));

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
  expect(deps.wake).toHaveBeenCalledWith(LISTENING, expect.any(String));
  expect(deps.recorded).not.toHaveBeenCalled();
  expect(posted.size).toBe(0);
});

test("a reply with no live turn wakes the parked run", async () => {
  wakeOutcome = { outcome: "woken" };
  expect(await route(prompted())).toBe("woken");
  expect(deps.wake).toHaveBeenCalledWith(LISTENING, expect.any(String));
  expect(posted.size).toBe(0);
});

test("a reply the run already took as it stopped listening gets no answer", async () => {
  holder = RUN;
  last = { type: "thought", createdAt: "2026-10-07T00:00:01.000Z" };
  expect(await route(prompted())).toBe("woken");
  expect(posted.size).toBe(0);
});

test("a reply to a run that has posted its final response gets no answer", async () => {
  holder = RUN;
  last = { type: "response", createdAt: "2026-10-06T00:00:00.000Z" };
  expect(await route(prompted())).toBe("woken");
  expect(posted.size).toBe(0);
});

test("a reply to a run waiting on people asks again, once, so the session stays awaiting input", async () => {
  holder = RUN;
  last = { type: "elicitation", createdAt: "2026-10-06T00:00:00.000Z" };
  const event = prompted();
  const types: string[] = [];
  const linear = deps.linear;
  deps.linear = (name) => {
    const api = linear(name);
    return {
      ...api,
      postActivityOnce: (sessionId, content, id) => {
        types.push(content.type);
        return api.postActivityOnce(sessionId, content, id);
      },
    };
  };

  expect(await route(event)).toBe("woken");
  expect(await route(event)).toBe("woken");

  expect(types[0]).toBe("elicitation");
  expect([...posted.entries()]).toEqual([
    [
      derivedUuid(["linear-session-waiting", event.agentActivity.id]),
      {
        sessionId: "session-1",
        body: "I can't take instructions here while I wait; my earlier message says where to act.",
      },
    ],
  ]);
});

test("a reply to a run that holds the session but is not listening is told it is working, once", async () => {
  holder = RUN;
  last = { type: "thought", createdAt: "2026-10-06T00:00:00.000Z" };
  statuses = new Map([[RUN, "running"]]);
  const event = prompted();

  expect(await route(event)).toBe("woken");
  expect(await route(event)).toBe("woken");

  expect([...posted.entries()]).toEqual([
    [
      derivedUuid(["linear-session-working", event.agentActivity.id]),
      {
        sessionId: "session-1",
        body: "I'm working and can't take instructions mid-run; I'll ask here if I need you. Use Stop to end the run.",
      },
    ],
  ]);
  expect(deps.recorded).not.toHaveBeenCalled();
});

test("a stop to a run that is not listening cancels the run holding the session", async () => {
  holder = RUN;
  statuses = new Map([[RUN, "running"]]);
  const stop = stopEvent();

  expect(await route(stop)).toBe("dropped");
  expect(posted.size).toBe(0);
  await fireNext(STOP_GRACE_MS);

  expect(deps.cancelRun).toHaveBeenCalledExactlyOnceWith(RUN);
  expect([...posted.keys()]).toEqual([stoppedId(stop)]);
});

test("a reply a live turn takes stands even when no hook is held", async () => {
  liveTurn();
  expect(await route(prompted())).toBe("woken");
  expect(posted.size).toBe(0);
});

test("a reply after the session's runs ended is told the conversation is over, once", async () => {
  rows = [row()];
  statuses = new Map([[RUN, "completed"]]);
  const event = prompted();

  expect(await route(event)).toBe("dropped");
  expect(await route(event)).toBe("dropped");

  expect([...posted.entries()]).toEqual([
    [
      derivedUuid(["linear-session-ended", event.agentActivity.id]),
      {
        sessionId: "session-1",
        body: "This conversation has ended; mention @jigs again to start a new one.",
      },
    ],
  ]);
});

test("an ended message that cannot be posted is routed again", async () => {
  rows = [row()];
  statuses = new Map([[RUN, "completed"]]);
  postFailures = 1;
  const event = prompted();
  expect(await route(event)).toBe("failed");
  expect(await route(event)).toBe("dropped");
  expect(posted.size).toBe(1);
});

test("without the app's name, the ended message names no one", async () => {
  rows = [row({ state: "failed", runId: null, attemptedAt: null })];
  deps.appName = async () => {
    throw new Error("hub down");
  };
  await route(prompted());
  expect(bodies()).toEqual([
    "This conversation has ended; mention the app again to start a new one.",
  ]);
});

test("a session this factory never ran, or ran in another installation, is left alone", async () => {
  expect(await route(prompted())).toBe("ignored");
  rows = [row({ inputs: { installationName: "other", session: "session-1" } })];
  statuses = new Map([[RUN, "completed"]]);
  expect(await route(prompted())).toBe("ignored");
  expect(await route(stopEvent())).toBe("ignored");
  expect(posted.size).toBe(0);
  expect(timers).toEqual([]);
});

test("a reply while the session's run may still start waits for it to read the session", async () => {
  rows = [row({ state: "pending", runId: null, attemptedAt: null })];
  expect(await route(prompted())).toBe("dropped");
  rows = [row()];
  statuses = new Map([[RUN, "running"]]);
  expect(await route(prompted())).toBe("dropped");
  // A failed start that was attempted can still be adopted as started.
  rows = [row({ state: "failed", runId: null })];
  expect(await route(prompted())).toBe("dropped");
  expect(posted.size).toBe(0);
});

test("a lookup that cannot answer, as while the triggers shut down, is routed again", async () => {
  deps.recorded.mockRejectedValueOnce(new Error("the event triggers have shut down"));
  expect(await route(prompted())).toBe("failed");
  expect(posted.size).toBe(0);
});

test("a wake that could not be delivered is routed again", async () => {
  wakeOutcome = { outcome: "failed", error: "db down" };
  expect(await route(prompted())).toBe("failed");
  expect(posted.size).toBe(0);
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
  rows = [row()];
  statuses = new Map([[RUN, "running"]]);

  expect(await route(stopEvent())).toBe("woken");

  expect(live.stop).toHaveBeenCalledOnce();
  expect(live.inject).not.toHaveBeenCalled();
  expect(deps.wake).toHaveBeenCalledWith(LISTENING, expect.any(String));
  answered = true;
  await fireNext(STOP_GRACE_MS);
  expect(deps.cancelRun).not.toHaveBeenCalled();
  expect(posted.size).toBe(0);
  expect(timers).toEqual([]);
});

test("a stop no run answers in time cancels every live run of the session and ends it", async () => {
  wakeOutcome = { outcome: "woken" };
  rows = [row(), row({ trigger: "other-trigger", runId: OTHER_RUN }), row({ runId: "wrun_done" })];
  statuses = new Map([
    [RUN, "running"],
    [OTHER_RUN, "pending"],
    ["wrun_done", "completed"],
  ]);
  const stop = stopEvent();

  expect(await route(stop)).toBe("woken");
  expect(posted.size).toBe(0);
  await fireNext(STOP_GRACE_MS);

  expect(deps.cancelRun.mock.calls).toEqual([[RUN], [OTHER_RUN]]);
  expect([...posted.entries()]).toEqual([
    [stoppedId(stop), { sessionId: "session-1", body: "Stopped." }],
  ]);
});

test("a stop withdraws a run not yet claimed for starting, so it never starts", async () => {
  rows = [row({ state: "pending", runId: null, attemptedAt: null })];

  expect(await route(stopEvent())).toBe("dropped");

  expect(deps.withdraw).toHaveBeenCalledOnce();
  expect(rows[0]?.state).toBe("skipped");
  expect(bodies()).toEqual(["Stopped."]);
  expect(timers).toEqual([]);
});

test("a stop while a start is in flight waits, then cancels the run it started", async () => {
  rows = [row({ state: "pending", runId: null })];
  expect(await route(stopEvent())).toBe("dropped");
  expect(timers).toHaveLength(1);

  rows = [row()];
  statuses = new Map([[RUN, "running"]]);
  await fireNext(STOP_GRACE_MS);
  expect(deps.cancelRun).toHaveBeenCalledExactlyOnceWith(RUN);
  expect(bodies()).toEqual(["Stopped."]);
});

test("a stop routed twice waits once", async () => {
  wakeOutcome = { outcome: "woken" };
  const stop = stopEvent();
  await route(stop);
  await route(stop);
  expect(timers).toHaveLength(1);
  await fireNext();
});

test("a fallback that fails tries again with backoff, then gives up to Linear's own timeout", async () => {
  wakeOutcome = { outcome: "woken" };
  rows = [row()];
  statuses = new Map([[RUN, "running"]]);
  postFailures = 3;

  await route(stopEvent());
  await fireNext(STOP_GRACE_MS);
  await fireNext(5_000);
  await fireNext(15_000);

  expect(timers).toEqual([]);
  expect(posted.size).toBe(0);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Linear is down"));
});

test("a fallback that fails once still ends the session on its retry, posting once", async () => {
  wakeOutcome = { outcome: "woken" };
  postFailures = 1;
  const stop = stopEvent();
  await route(stop);
  await fireNext(STOP_GRACE_MS);
  await fireNext(5_000);
  expect([...posted.keys()]).toEqual([stoppedId(stop)]);
});

test("a stop after the session's runs ended is answered at once, and only once", async () => {
  rows = [row()];
  statuses = new Map([[RUN, "cancelled"]]);
  const stop = stopEvent();

  expect(await route(stop)).toBe("dropped");
  expect(await route(stop)).toBe("dropped");

  expect([...posted.keys()]).toEqual([stoppedId(stop)]);
  expect(timers).toEqual([]);
});

test("a Stopped. that cannot be posted at once is routed again", async () => {
  rows = [row()];
  statuses = new Map([[RUN, "cancelled"]]);
  postFailures = 1;
  expect(await route(stopEvent())).toBe("failed");
});

test("an event that is not a readable prompt is ignored", async () => {
  expect(await route({ type: "AgentSessionEvent", action: "prompted" })).toBe("ignored");
  expect(deps.wake).not.toHaveBeenCalled();
});

const ENDED_RUN =
  "This conversation has ended. Assign the issue to @jigs or mention @jigs to start a new run.";

test("a message in an ended ticket run's session is told the run ended, once", async () => {
  last = { type: "response", createdAt: "2026-10-06T00:00:00.000Z" };
  const event = prompted({ creatorId: null });

  expect(await route(event)).toBe("dropped");
  expect(await route(event)).toBe("dropped");

  expect([...posted.entries()]).toEqual([
    [
      derivedUuid(["linear-ticket-session-ended", event.agentActivity.id]),
      { sessionId: "session-1", body: ENDED_RUN },
    ],
  ]);
  expect(deps.recorded).not.toHaveBeenCalled();
});

test.each([
  ["a thought", "thought"],
  ["an elicitation", "elicitation"],
])(
  "a ticket run session whose app last posted %s is another factory's live run, and gets no reply",
  async (_, type) => {
    last = { type, createdAt: "2026-10-06T00:00:00.000Z" };
    expect(await route(prompted({ creatorId: null }))).toBe("ignored");
    expect(posted.size).toBe(0);
  },
);

test("a ticket run session with no app activity gets no reply", async () => {
  expect(await route(prompted({ creatorId: null }))).toBe("ignored");
  expect(posted.size).toBe(0);
});

test("a session a person started is answered by its occurrences, not as a ticket run's", async () => {
  last = { type: "response", createdAt: "2026-10-06T00:00:00.000Z" };
  expect(await route(prompted())).toBe("ignored");
  expect(deps.recorded).toHaveBeenCalled();
  expect(posted.size).toBe(0);
});
