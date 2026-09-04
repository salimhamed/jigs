import { CliError } from "../errors.ts";
import { formatTable } from "../table.ts";
import {
  readErrorBody,
  runRefError,
  type ServiceDeps,
  serviceFetch,
} from "./service.ts";

// jigs contributes the two things the dashboard cannot — resolving a ticket id
// or a ULID prefix to a run, and the queue jobs that died holding its resume —
// then points at the run's page on the dashboard the service hosts.

export interface LogsResult {
  runId: string;
  status: string;
  error?: string;
  logs: string;
  suspensions?: Array<{ key: string; reason: string; satisfiedBy: string }>;
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

export async function showLogs(
  ref: string,
  deps: ServiceDeps,
): Promise<LogsResult> {
  const res = await serviceFetch(deps, `/api/runs/${encodeURIComponent(ref)}`);
  if (res.status === 404 || res.status === 409) {
    throw runRefError(ref, await readErrorBody(res));
  }
  if (!res.ok) {
    throw new CliError(`logs failed: HTTP ${res.status} ${await res.text()}`);
  }
  const result = (await res.json()) as LogsResult;
  deps.out(`run ${result.runId}`);
  deps.out(`status ${result.status}`);
  if (result.error !== undefined) deps.out(`error ${result.error}`);
  for (const suspension of result.suspensions ?? []) {
    deps.out(`suspended on ${suspension.key}: ${suspension.reason}`);
    deps.out(`  satisfied by ${suspension.satisfiedBy}`);
  }
  deps.out(result.logs);
  await showTimeline(result.runId, deps);
  return result;
}

// A timeline the service cannot read still leaves the run's own state above,
// which is the answer to "what is this run doing" — but say so rather than
// let the missing table read as a run with no steps.
async function showTimeline(runId: string, deps: ServiceDeps): Promise<void> {
  const res = await serviceFetch(deps, `/api/runs/${runId}/steps`);
  if (!res.ok) {
    deps.out(`timeline unavailable: HTTP ${res.status}`);
    return;
  }
  const { steps, deadJobs } = (await res.json()) as {
    steps: StepRow[];
    deadJobs: DeadJob[];
  };
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
  for (const job of deadJobs) {
    deps.out("");
    deps.out(
      `dead job ${job.id} (${job.task}) after ${job.attempts} attempts: ${firstLine(job.lastError)}`,
    );
    deps.out(
      `  requeue: select graphile_worker.reschedule_jobs(array[${job.id}]::bigint[], run_at := now(), attempts := 0)`,
    );
  }
}

function took(step: StepRow): string {
  if (step.startedAt === null) return "-";
  if (step.completedAt === null) return "running";
  const ms =
    new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// A queue job's last error can be a whole HTML error page on one line, and
// the requeue below it is the part an operator acts on.
const ERROR_WIDTH = 160;

function firstLine(text: string | null): string {
  const line = text === null ? "" : (text.split("\n")[0] ?? "");
  return line.length > ERROR_WIDTH ? `${line.slice(0, ERROR_WIDTH)}…` : line;
}
