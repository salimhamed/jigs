import { JigsError } from "../../errors.ts";
import { outcomeNeedsAttention } from "../../run-status.ts";
import { formatTable } from "../table.ts";
import { age, outcomeCell, type PsRun, suspensionLine } from "./ps.ts";
import { readErrorBody, runRefError, type ServiceDeps, serviceFetch } from "./service-client.ts";

// jigs contributes the two things the dashboard cannot — resolving a ticket id
// or a ULID prefix to a run, and the queue jobs that died holding its resume —
// then points at the run's page on the dashboard the service hosts.

export interface LogsResult extends Omit<PsRun, "workflow"> {
  error?: string;
  returnValue?: unknown;
  logs: string;
}

interface StepRow {
  name: string;
  status: string;
  attempt: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

interface DeadJob {
  id: string;
  task: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

interface Timeline {
  steps?: StepRow[];
  deadJobs?: DeadJob[];
  error?: string;
}

export interface LogsOptions {
  json?: boolean;
  now?: Date;
}

export async function showLogs(
  ref: string,
  deps: ServiceDeps,
  options: LogsOptions = {},
): Promise<LogsResult> {
  const res = await serviceFetch(deps.serviceUrl, `/api/runs/${encodeURIComponent(ref)}`);
  if (res.status === 404 || res.status === 409) {
    throw runRefError(ref, await readErrorBody(res));
  }
  if (!res.ok) {
    throw new JigsError(`logs failed: HTTP ${res.status} ${await res.text()}`);
  }
  const result = (await res.json()) as LogsResult;
  const timeline = await fetchTimeline(result.runId, deps);

  if (options.json === true) {
    deps.out(JSON.stringify({ ...result, timeline }, null, 2));
    return result;
  }

  const now = options.now ?? new Date();
  deps.out(`run ${result.runId}`);
  deps.out(`status ${result.status}`);
  if (result.outcome !== null) deps.out(`outcome ${outcomeLine(result.outcome)}`);
  deps.out(`trigger ${result.trigger}`);
  if (result.ticket !== null) deps.out(`ticket ${result.ticket}`);
  if (result.pullRequest !== null) deps.out(`pull request ${result.pullRequest}`);
  deps.out(`last activity ${age(result.lastActivityAt, now)} ago (${result.lastActivityAt})`);
  if (result.error !== undefined) deps.out(`error ${result.error}`);
  // What the run is waiting for, and where to go and act on it — the token
  // itself is an implementation detail of the hook it parked on.
  for (const suspension of result.suspensions) {
    deps.out(suspensionLine(suspension));
    if (suspension.question !== undefined) {
      deps.out("asked:");
      for (const line of suspension.question.split("\n")) deps.out(`  ${line}`);
    }
  }
  deps.out(result.logs);
  showTimeline(timeline, deps);
  return result;
}

// A timeline the service cannot read still leaves the run's own state above,
// which is the answer to "what is this run doing" — but say so rather than
// let the missing table read as a run with no steps.
async function fetchTimeline(runId: string, deps: ServiceDeps): Promise<Timeline> {
  const res = await serviceFetch(deps.serviceUrl, `/api/runs/${runId}/steps`);
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return (await res.json()) as Timeline;
}

function showTimeline(timeline: Timeline, deps: ServiceDeps): void {
  if (timeline.error !== undefined) {
    deps.out(`timeline unavailable: ${timeline.error}`);
    return;
  }
  const steps = timeline.steps ?? [];
  if (steps.length > 0) {
    deps.out("");
    for (const line of formatTable(
      ["STEP", "STATUS", "ATTEMPT", "STARTED", "TOOK", "ERROR"],
      steps.map((step) => [
        step.name,
        step.status,
        String(step.attempt),
        step.startedAt ?? "-",
        took(step),
        firstLine(step.error),
      ]),
    )) {
      deps.out(line);
    }
  }
  // The queue gave up on these, so nothing is coming to move the run. jigs
  // prints the requeue rather than running it: what to do about a job that
  // failed three times is the operator's call.
  for (const job of timeline.deadJobs ?? []) {
    deps.out("");
    deps.out(
      `dead job ${job.id} (${job.task}) after ${job.attempts} attempts: ${firstLine(job.lastError)}`,
    );
    deps.out(
      `  requeue: select graphile_worker.reschedule_jobs(array[${job.id}]::bigint[], run_at := now(), attempts := 0)`,
    );
  }
}

const outcomeLine = (outcome: string): string =>
  outcomeNeedsAttention(outcome) ? `${outcomeCell(outcome)} — this run did not succeed` : outcome;

function took(step: StepRow): string {
  if (step.startedAt === null) return "-";
  if (step.completedAt === null) return "running";
  const ms = new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// A queue job's last error can be a whole HTML error page on one line, and
// the requeue below it is the part an operator acts on.
const ERROR_WIDTH = 160;

function firstLine(text: string | null): string {
  const line = text === null ? "" : (text.split("\n")[0] ?? "");
  return line.length > ERROR_WIDTH ? `${line.slice(0, ERROR_WIDTH)}…` : line;
}
