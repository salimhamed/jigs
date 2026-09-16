import { JigsError } from "../../errors.ts";
import { outcomeNeedsAttention, TERMINAL_RUN_STATUSES } from "../../run-status.ts";
import { listFactoryRuns, type PsRun, suspensionLine, waitingCell } from "./ps.ts";
import type { ServiceDeps } from "./service-client.ts";

// One long-lived process for the whole factory: a watcher that re-ran `jigs
// ps` would pay a node start-up per poll, and the service hosts no event
// stream to subscribe to. The poll reads the one listing route; every event
// below is a difference between two of its answers.

export type WatchEventName =
  | "watching"
  | "appeared"
  | "step"
  | "suspended"
  | "resumed"
  | "status"
  | "finished"
  | "unreachable";

export interface WatchEvent {
  at: string;
  event: WatchEventName;
  runId: string;
  workflow: string;
  ticket: string | null;
  status: string;
  outcome: string | null;
  pullRequest: string | null;
  detail: string;
}

export interface WatchOptions {
  json?: boolean;
  intervalMs?: number;
  /** Stop after this many polls. The CLI passes none and runs until killed. */
  polls?: number;
}

export interface WatchDeps extends ServiceDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const DEFAULT_INTERVAL_MS = 5_000;

export async function watchRuns(deps: WatchDeps, options: WatchOptions = {}): Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const now = deps.now ?? (() => new Date());
  let previous: Map<string, PsRun> | undefined;

  for (let poll = 0; options.polls === undefined || poll < options.polls; poll++) {
    if (poll > 0) await sleep(intervalMs);
    const at = now().toISOString();
    let runs: PsRun[];
    try {
      ({ runs } = await listFactoryRuns(deps));
    } catch (error) {
      // A restarted service is the expected interruption, not the end of the
      // watch: say so on one line and keep the last snapshot to diff against.
      emit(deps, options, unreachable(at, error));
      continue;
    }
    for (const run of runs) {
      for (const event of previous === undefined
        ? opening(run, at)
        : runEvents(previous.get(run.runId), run, at)) {
        emit(deps, options, event);
      }
    }
    previous = new Map(runs.map((run) => [run.runId, run]));
  }
}

/** What the factory looks like the moment a watch starts: every run still in
 *  play, so nothing has to be read from a table first. */
function opening(run: PsRun, at: string): WatchEvent[] {
  if (TERMINAL_RUN_STATUSES.has(run.status)) return [];
  return [event(run, at, "watching", waitingCell(run))];
}

/** Every difference between two answers about one run, in the order it
 *  happened: the step finished first, then the run parked on what comes next. */
export function runEvents(previous: PsRun | undefined, next: PsRun, at: string): WatchEvent[] {
  if (previous === undefined) {
    return [event(next, at, "appeared", next.ticket ?? next.workflow)];
  }
  const events: WatchEvent[] = [];
  if (next.lastStep !== null && stepKey(next) !== stepKey(previous)) {
    events.push(
      event(next, at, "step", `${next.steps} ${next.lastStep.name} ${next.lastStep.status}`),
    );
  }
  if (next.status !== previous.status) events.push(statusEvent(previous, next, at));
  return events;
}

function statusEvent(previous: PsRun, next: PsRun, at: string): WatchEvent {
  if (TERMINAL_RUN_STATUSES.has(next.status)) {
    return event(next, at, "finished", finishedDetail(next));
  }
  if (next.status === "suspended") {
    return event(next, at, "suspended", next.suspensions.map(suspensionLine).join("; "));
  }
  if (previous.status === "suspended") return event(next, at, "resumed", next.status);
  return event(next, at, "status", next.status);
}

const finishedDetail = (run: PsRun): string =>
  run.outcome === null
    ? run.status
    : outcomeNeedsAttention(run.outcome)
      ? `${run.outcome} — this run did not succeed`
      : run.outcome;

const stepKey = (run: PsRun): string =>
  `${run.steps}:${run.lastStep?.name ?? ""}:${run.lastStep?.status ?? ""}:${run.lastStep?.at ?? ""}`;

function event(run: PsRun, at: string, name: WatchEventName, detail: string): WatchEvent {
  return {
    at,
    event: name,
    runId: run.runId,
    workflow: run.workflow,
    ticket: run.ticket,
    status: run.status,
    outcome: run.outcome,
    pullRequest: run.pullRequest,
    detail,
  };
}

const unreachable = (at: string, error: unknown): WatchEvent => ({
  at,
  event: "unreachable",
  runId: "",
  workflow: "",
  ticket: null,
  status: "",
  outcome: null,
  pullRequest: null,
  detail: error instanceof JigsError ? error.message : String(error),
});

function emit(deps: WatchDeps, options: WatchOptions, watched: WatchEvent): void {
  deps.out(options.json === true ? JSON.stringify(watched) : formatEvent(watched));
}

/** One line per event, fields first so a reader can cut on spaces. */
export function formatEvent(watched: WatchEvent): string {
  const subject = watched.ticket ?? watched.workflow;
  return [watched.at, watched.runId, subject, watched.event, watched.detail]
    .filter((field) => field !== "")
    .join(" ");
}
