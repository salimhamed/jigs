// One Slack thread per run, and that run's milestones posted into it.
//
// Observed from outside, never emitted from inside: no step knows this
// factory has a Slack app, and a pipeline that had to say "I am parking now"
// would be a pipeline whose author had to remember to. So the milestones are
// read off the run the way the operator reads them — through the same run
// listing `jigs ps` answers with — which also makes them honest: the run's
// real state, not what a step believed when it wrote the line.
//
// One tick covers every watched run: the listing derives the status of all of
// them at once, and only a run whose state actually moved costs a detail read
// (the one thing that can name what a park is waiting on). That is what makes
// a run nobody ever marks terminal affordable — the SDK leaves one there when
// its argument capture fails serialization (ADR 0008), and jigs would then
// watch it for the life of the process. It costs a row in a listing this tick
// was making anyway, not a query of its own.

import type { ISql } from "postgres";
import { DASHBOARD_NOT_CONFIGURED, type RunDetail } from "../run-actions";
import type { RunStarted } from "../run-events";
import { type RunRow, TERMINAL_RUN_STATUSES, triggerLabel } from "../runs";
import { TICKET_CLAIM_KEYS } from "../suspension/record";
import type { ThreadRunContext } from "./agent";
import {
  getRunForSlackThread,
  getSlackThreadForRun,
  insertSlackThread,
  listSlackThreadsForRuns,
} from "./threads-table";

/** Often enough that a parked run is news, rarely enough that a factory with
 *  a hundred runs in flight is one listing every twenty seconds. */
export const DEFAULT_POLL_MS = 20_000;

// A failed run's error can be a whole stack; a thread wants the line that says
// what happened.
const ERROR_CHARS = 300;

/**
 * What a watched run is, as far as a milestone is concerned. The SDK's own
 * enum is pending | running | completed | failed | cancelled, and jigs derives
 * suspended and stalled on top of it — but every run is created `pending` and
 * becomes `running` moments later, and leaving a queue is not news. Both are
 * `active`.
 */
export type RunState =
  | "active"
  | "suspended"
  | "stalled"
  | "completed"
  | "failed"
  | "cancelled";

export function runState(status: string): RunState {
  if (status === "suspended" || status === "stalled") return status;
  return TERMINAL_RUN_STATUSES.has(status) ? (status as RunState) : "active";
}

/** The repeating clock the watch runs on; the returned function stops it.
 *  Injected so a test needs no timers. */
export type Ticker = (ms: number, tick: () => void) => () => void;

const realTicker: Ticker = (ms, tick) => {
  const timer = setInterval(tick, ms);
  // Runs being watched is not a reason for the process to stay up.
  timer.unref?.();
  return () => clearInterval(timer);
};

export interface RunThreadsDeps {
  /** Where a run that was not started from a thread gets one opened. */
  channel: string;
  sql: () => ISql | null;
  /** Posts to the channel and answers with the new message's ts — the thread
   *  every later milestone hangs under. */
  openThread(channel: string, text: string): Promise<string | null>;
  postReply(channel: string, threadTs: string, text: string): Promise<void>;
  /** Every run's derived status in one read: the tick's whole input. */
  listRuns(): Promise<RunRow[]>;
  /** The fuller read, made only for a run that moved — it is the only thing
   *  that can say what a park is waiting on. */
  runDetail(runId: string): Promise<RunDetail>;
  log(line: string): void;
  error(line: string): void;
  intervalMs?: number;
  ticker?: Ticker;
}

export interface RunThreads {
  /** Map the run to a thread, announce it unless the thread already knows,
   *  and start watching. Never rejects. */
  runStarted(event: RunStarted): Promise<void>;
  /** Pick the watch back up at service start, for the runs still in flight. */
  rehydrate(runIds: readonly string[]): Promise<void>;
  /** The run this thread belongs to, or null — including when the answer
   *  cannot be read, because a question still deserves an answer. */
  threadRun(
    channel: string,
    threadTs: string,
  ): Promise<ThreadRunContext | null>;
  stop(): void;
}

/** The run's first message: what it is, who launched it, and where to watch
 *  it. A run started from a thread never gets one — the agent's own reply in
 *  that thread already said all of it. */
export function rootMessage(event: RunStarted): string {
  return [
    `Run started: ${event.pipeline} (${triggerLabel(event.triggerId)})`,
    event.runId,
    ...link(event.logs),
  ].join("\n");
}

/**
 * What to say about a run that has moved to the state its detail reports,
 * coming from `from`. Empty when the move is worth no words — a run leaving
 * the queue, or one whose detail says it did not move after all.
 */
export function milestone(detail: RunDetail, from: RunState | null): string {
  const { runId } = detail;
  const to = runState(detail.status);
  if (to === from) return "";
  switch (to) {
    case "failed":
      return [
        `${runId} failed: ${firstLine(detail.error)}`,
        ...link(detail.logs),
      ].join("\n");
    case "completed":
    case "cancelled":
      return `${runId} ${to}`;
    case "suspended": {
      const reasons = parkReasons(detail);
      return reasons.length === 0
        ? `${runId} is parked`
        : `${runId} is parked: ${reasons.join("; ")}`;
    }
    case "stalled":
      return [
        `${runId} is stalled — nothing is coming to move it`,
        ...link(detail.logs),
      ].join("\n");
    case "active":
      // Coming back from a park is news; starting to work never is — the
      // run's own first message already said it began.
      return from === "suspended" || from === "stalled"
        ? `${runId} resumed`
        : "";
  }
}

interface Watched {
  channel: string;
  threadTs: string;
  /** The state already accounted for. Null until the first read: a watch
   *  inherited from before a restart primes silently rather than
   *  re-announcing a park the thread already carries. */
  state: RunState | null;
}

export function createRunThreads(deps: RunThreadsDeps): RunThreads {
  const ticker = deps.ticker ?? realTicker;
  const intervalMs = deps.intervalMs ?? DEFAULT_POLL_MS;
  const watched = new Map<string, Watched>();
  let cancelTick: (() => void) | null = null;
  let busy = false;

  function watch(runId: string, entry: Watched): void {
    if (watched.has(runId)) return;
    watched.set(runId, entry);
    // The clock runs only while there is something to watch.
    cancelTick ??= ticker(intervalMs, () => {
      // A timer callback that throws takes the process with it — the same
      // reason fireSchedule catches everything.
      void tick().catch((err: unknown) =>
        deps.error(`[slack] watching runs failed: ${describe(err)}`),
      );
    });
  }

  function unwatch(runId: string): void {
    watched.delete(runId);
    if (watched.size > 0) return;
    cancelTick?.();
    cancelTick = null;
  }

  async function tick(): Promise<void> {
    // A slow listing must not stack ticks up behind it.
    if (busy || watched.size === 0) return;
    busy = true;
    try {
      const listed = new Map(
        (await deps.listRuns()).map((row) => [row.runId, runState(row.status)]),
      );
      for (const [runId, entry] of [...watched]) {
        const seen = listed.get(runId);
        // A run the listing does not carry says nothing about the run — only
        // that a page boundary or a forgetful World got in the way.
        if (seen === undefined || seen === entry.state) continue;
        await announce(runId, entry);
      }
    } finally {
      busy = false;
    }
  }

  // The detail read is the fresher and fuller answer, so it decides both what
  // is said and what is remembered; the listing above only decides whether it
  // is worth asking for.
  async function announce(runId: string, entry: Watched): Promise<void> {
    const detail = await deps.runDetail(runId);
    const text = milestone(detail, entry.state);
    // A terminal state is announced even by a priming read: a run that ended
    // while the service was down is the one milestone worth catching up on.
    const primed = entry.state !== null;
    const to = runState(detail.status);
    const terminal = TERMINAL_RUN_STATUSES.has(to);
    entry.state = to;
    // Posted before the unwatch below, and its failure swallowed there: Slack
    // refusing a message must not leave a run watched forever after it is over.
    if (text !== "" && (primed || terminal)) {
      await deps
        .postReply(entry.channel, entry.threadTs, text)
        .catch((err: unknown) =>
          deps.error(
            `[slack] could not post to ${entry.channel}/${entry.threadTs}: ${describe(err)}`,
          ),
        );
    }
    if (terminal) unwatch(runId);
  }

  return {
    runStarted: async (event) => {
      const origin = event.origin;
      try {
        // Inside the try: opening the connection is itself fallible, and a
        // World that will not answer must cost this run its thread, not its
        // life.
        const sql = deps.sql();
        if (sql === null) return;
        // The thread first, the row second: the mapping cannot be written
        // before Slack has said what the thread is.
        const channel = origin === undefined ? deps.channel : origin.channel;
        const threadTs =
          origin === undefined
            ? await deps.openThread(deps.channel, rootMessage(event))
            : origin.threadTs;
        if (threadTs === null) {
          deps.error(
            `[slack] run ${event.runId} has no thread: Slack accepted its first message without a ts`,
          );
          return;
        }
        await insertSlackThread(sql, { runId: event.runId, channel, threadTs });
        // Read back rather than assumed: the insert keeps a mapping already
        // there, so the thread to post in is the one the table names, not the
        // one this call wanted.
        const mapped = await getSlackThreadForRun(sql, event.runId);
        watch(event.runId, {
          channel: mapped?.channel ?? channel,
          threadTs: mapped?.threadTs ?? threadTs,
          state: "active",
        });
      } catch (err) {
        // The run is already running; Slack is the part that failed.
        deps.error(
          `[slack] could not open a thread for run ${event.runId}: ${describe(err)}`,
        );
      }
    },

    rehydrate: async (runIds) => {
      const sql = deps.sql();
      if (sql === null || runIds.length === 0) return;
      const rows = await listSlackThreadsForRuns(sql, runIds);
      for (const row of rows) {
        watch(row.runId, {
          channel: row.channel,
          threadTs: row.threadTs,
          state: null,
        });
      }
      if (rows.length > 0) {
        deps.log(`[slack] watching ${rows.length} run(s) already in flight`);
      }
    },

    threadRun: async (channel, threadTs) => {
      try {
        const sql = deps.sql();
        if (sql === null) return null;
        const row = await getRunForSlackThread(sql, channel, threadTs);
        if (row === null) return null;
        const run = (await deps.listRuns()).find((r) => r.runId === row.runId);
        return run === undefined
          ? null
          : { runId: run.runId, pipeline: run.pipeline, status: run.status };
      } catch (err) {
        deps.error(
          `[slack] could not place thread ${channel}/${threadTs}: ${describe(err)}`,
        );
        return null;
      }
    },

    stop: () => {
      watched.clear();
      cancelTick?.();
      cancelTick = null;
    },
  };
}

// Sorted, so two reads of the same park read the same however the World
// ordered its hooks.
function parkReasons(detail: RunDetail): string[] {
  return [
    ...new Set(
      (detail.suspensions ?? [])
        .filter((record) => !TICKET_CLAIM_KEYS.has(record.key))
        .map((record) => record.reason),
    ),
  ].sort();
}

// A service with no dashboard port has no page to point at, and a line saying
// so is a line nobody can act on.
function link(logs: string): string[] {
  return logs === DASHBOARD_NOT_CONFIGURED ? [] : [logs];
}

function firstLine(error: string | undefined): string {
  const text = (error ?? "").trim();
  if (text === "") return "no error recorded";
  const first = text.split("\n")[0] ?? text;
  return first.length <= ERROR_CHARS
    ? first
    : `${first.slice(0, ERROR_CHARS)}…`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
