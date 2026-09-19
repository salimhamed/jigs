import type { CleanupView } from "../../blocks/runtime/cleanup.ts";
import type { RunResource } from "../../blocks/runtime/resources.ts";
import { JigsError } from "../../errors.ts";
import { formatTable } from "../table.ts";
import { age, type PsRun, suspensionLine } from "./ps.ts";
import { readErrorBody, runRefError, type ServiceDeps, serviceFetch } from "./service-client.ts";

// jigs contributes the two things the dashboard cannot — resolving a ticket id
// or a ULID prefix to a run, and the queue jobs that died holding its resume —
// then points at the run's page on the dashboard the service hosts.

export interface LogsResult extends Omit<PsRun, "workflow"> {
  error?: string;
  returnValue?: unknown;
  logs: string;
  resources: RunResource[];
  cleanup: CleanupView;
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
  deps.out(`trigger ${result.trigger}`);
  if (result.ticket !== null) deps.out(`ticket ${result.ticket}`);
  deps.out(`last activity ${age(result.lastActivityAt, now)} ago (${result.lastActivityAt})`);
  showResources(result.resources, deps);
  showCleanup(result.cleanup, deps);
  if (result.error !== undefined) deps.out(`error ${result.error}`);
  if (result.status === "completed") {
    showResult(result.returnValue, deps);
  }
  // What the run is waiting for, and where to go and act on it — the token
  // itself is an implementation detail of the hook it parked on.
  for (const suspension of result.suspensions) {
    deps.out(suspensionLine(suspension));
    // Only the single-run route reads the providers, so these are absent
    // whenever GitHub could not be asked.
    if (suspension.headSha !== undefined) {
      deps.out(`  head sha: ${suspension.headSha}`);
      deps.out(`  CI: ${suspension.ci}`);
      deps.out(`  approval: ${suspension.approval}`);
      deps.out(`  draft: ${suspension.draft === true ? "yes" : "no"}`);
      deps.out(`  mergeable state: ${suspension.mergeState}`);
      deps.out(`  blocker: ${suspension.blocker}`);
    }
    const wake = suspension.lastWake;
    if (wake !== undefined) {
      deps.out(`  last wake: ${wake.kind}, ${age(wake.at, now)} ago (${wake.at})`);
    }
    if (suspension.question !== undefined) {
      deps.out("asked:");
      for (const line of suspension.question.split("\n")) deps.out(`  ${line}`);
    }
  }
  deps.out(result.logs);
  showTimeline(timeline, deps);
  return result;
}

function showCleanup(cleanup: CleanupView, deps: ServiceDeps): void {
  if (cleanup.status === "waiting") return;
  const counts = [
    ["released", cleanup.released],
    ["kept", cleanup.kept],
    ["failed", cleanup.failed],
    ["unknown", cleanup.unknown],
  ]
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .map(([label, count]) => `${count} ${label}`)
    .join(", ");
  deps.out(
    `cleanup ${cleanup.status} (${cleanup.directive}${cleanup.outcome === undefined ? "" : `, ${cleanup.outcome}`}${counts === "" ? "" : `; ${counts}`})`,
  );
  if (cleanup.detail !== undefined) deps.out(`  ${singleLine(cleanup.detail)}`);
}

const RESULT_KEY_LIMIT = 12;

function showResult(value: unknown, deps: ServiceDeps): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    deps.out(`result: ${formatResultValue(value)}`);
    return;
  }

  const entries = Object.entries(value);
  deps.out("result:");
  for (const [key, entryValue] of entries.slice(0, RESULT_KEY_LIMIT)) {
    deps.out(`  ${singleLine(key)}: ${formatResultValue(entryValue)}`);
  }
  const omitted = entries.length - RESULT_KEY_LIMIT;
  if (omitted > 0) deps.out(`  … ${omitted} more ${omitted === 1 ? "key" : "keys"}`);
}

function showResources(resources: readonly RunResource[], deps: ServiceDeps): void {
  if (resources.length === 0) {
    deps.out("resources none");
    return;
  }
  deps.out("resources:");
  for (const resource of resources) {
    deps.out(
      `  ${singleLine(resource.kind)} ${singleLine(resource.identity)} → ${singleLine(resource.url)}`,
    );
  }
}

function formatResultValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length} ${value.length === 1 ? "item" : "items"}]`;
  if (value !== null && typeof value === "object") return "{…}";
  return singleLine(String(value));
}

function singleLine(value: string): string {
  return value.replace(/\r\n|\r|\n|\u2028|\u2029/g, (lineBreak) => {
    if (lineBreak === "\r") return "\\r";
    if (lineBreak === "\u2028") return "\\u2028";
    if (lineBreak === "\u2029") return "\\u2029";
    return "\\n";
  });
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
