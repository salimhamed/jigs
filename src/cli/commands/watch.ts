import { JigsError } from "../../errors.ts";
import { TERMINAL_RUN_STATUSES } from "../../run-status.ts";
import { listFactoryRuns, type RunListRun, suspensionLine, waitingCell } from "./run-list.ts";
import { runNotFound, type ServiceDeps, serviceFetch } from "./service-client.ts";

// One long-lived process for the whole factory: a watcher that re-ran `jigs
// status` would pay a node start-up per poll, and the service hosts no event
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
  detail: string;
}

export interface WatchOptions {
  json?: boolean;
  intervalMs?: number;
  /** Follow only this run. */
  runId?: string;
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
  const selectedRunId = options.runId;
  if (selectedRunId !== undefined) await requireRun(selectedRunId, deps);
  let previous: Map<string, RunListRun> | undefined;

  for (let poll = 0; options.polls === undefined || poll < options.polls; poll++) {
    if (poll > 0) await sleep(intervalMs);
    const at = now().toISOString();
    let runs: RunListRun[];
    try {
      ({ runs } = await listFactoryRuns(deps));
    } catch (error) {
      // A restarted service is the expected interruption, not the end of the
      // watch: say so on one line and keep the last snapshot to diff against.
      emit(deps, options, unreachable(at, error));
      continue;
    }
    // A run that drops out of the listing emits nothing: the world only stops
    // listing a run that was deleted, and a deletion is not something that
    // happened to the pipeline.
    for (const run of runs) {
      if (selectedRunId !== undefined && run.runId !== selectedRunId) continue;
      for (const event of previous === undefined
        ? opening(run, at)
        : runEvents(previous.get(run.runId), run, at)) {
        emit(deps, options, event);
      }
    }
    previous = new Map(
      runs
        .filter((run) => selectedRunId === undefined || run.runId === selectedRunId)
        .map((run) => [run.runId, run]),
    );
  }
}

async function requireRun(runId: string, deps: ServiceDeps): Promise<void> {
  const res = await serviceFetch(deps.serviceUrl, `/api/runs/${encodeURIComponent(runId)}`);
  if (res.status === 404) throw runNotFound(runId);
  if (!res.ok) {
    throw new JigsError(`watch failed: HTTP ${res.status} ${await res.text()}`);
  }
}

/** What the factory looks like the moment a watch starts: every run still in
 *  play, so nothing has to be read from a table first. */
function opening(run: RunListRun, at: string): WatchEvent[] {
  if (TERMINAL_RUN_STATUSES.has(run.status)) return [];
  return [event(run, at, "watching", waitingCell(run))];
}

/** Every difference between two answers about one run, in the order it
 *  happened: the step finished first, then the run parked on what comes next. */
export function runEvents(
  previous: RunListRun | undefined,
  next: RunListRun,
  at: string,
): WatchEvent[] {
  if (previous === undefined) {
    const appeared = event(next, at, "appeared", next.ticket ?? next.workflow);
    // A run that started and ended between two polls has to be as loud as one
    // watched the whole way: it is the failure nobody saw happen.
    return TERMINAL_RUN_STATUSES.has(next.status)
      ? [appeared, event(next, at, "finished", finishedDetail(next))]
      : [appeared];
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

function statusEvent(previous: RunListRun, next: RunListRun, at: string): WatchEvent {
  if (TERMINAL_RUN_STATUSES.has(next.status)) {
    return event(next, at, "finished", finishedDetail(next));
  }
  if (next.status === "suspended") {
    return event(next, at, "suspended", next.suspensions.map(suspensionLine).join("; "));
  }
  if (previous.status === "suspended") return event(next, at, "resumed", next.status);
  return event(next, at, "status", next.status);
}

const finishedDetail = (run: RunListRun): string => run.status;

const stepKey = (run: RunListRun): string =>
  `${run.steps}:${run.lastStep?.name ?? ""}:${run.lastStep?.status ?? ""}:${run.lastStep?.at ?? ""}`;

function event(run: RunListRun, at: string, name: WatchEventName, detail: string): WatchEvent {
  return {
    at,
    event: name,
    runId: run.runId,
    workflow: run.workflow,
    ticket: run.ticket,
    status: run.status,
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
