import { JigsError } from "../../errors.ts";
import type { ResourceRecord } from "../../workflow/runtime/resources.ts";
import {
  columns,
  detail,
  displayPath,
  formatTable,
  heading,
  hint,
  indent,
  note,
  runHeading,
  tone,
} from "../output.ts";
import { age, type RunListRun, type RunListSuspension, suspensionLine } from "./run-list.ts";
import { runNotFound, type ServiceDeps, serviceFetch } from "./service-client.ts";

// jigs contributes the two things the dashboard cannot — resolving a ticket id
// or a ULID prefix to a run, and the queue jobs that died holding its resume —
// then points at the run's page on the dashboard the service hosts.

export interface StatusResult extends Omit<RunListRun, "workflow"> {
  error?: string;
  returnValue?: unknown;
  dashboard: string;
  resources: ResourceRecord[];
  claim: string | null;
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

export interface StatusOptions {
  json?: boolean;
  now?: Date;
}

export async function showRunStatus(
  runId: string,
  deps: ServiceDeps,
  options: StatusOptions = {},
): Promise<StatusResult> {
  const res = await serviceFetch(deps.serviceUrl, `/api/runs/${encodeURIComponent(runId)}`);
  if (res.status === 404) throw runNotFound(runId);
  if (!res.ok) {
    throw new JigsError(`status failed: HTTP ${res.status} ${await res.text()}`);
  }
  const result = (await res.json()) as StatusResult;
  const timeline = await fetchTimeline(result.runId, deps);

  if (options.json === true) {
    deps.out(JSON.stringify({ ...result, timeline }, null, 2));
    return result;
  }

  const now = options.now ?? new Date();
  const facts: string[][] = [
    ["trigger", result.trigger],
    ...(result.ticket === null ? [] : [["ticket", result.ticket]]),
    ["last activity", `${age(result.lastActivityAt, now)} ago ${detail(result.lastActivityAt)}`],
    ...(result.error === undefined ? [] : [["error", singleLine(result.error)]]),
    ...(result.resources.length === 0 ? [["resources", "none"]] : []),
    ...scalarResult(result),
    ...(result.dashboard === "" ? [] : [["dashboard", result.dashboard]]),
  ];
  deps.out(runHeading(result.runId, result.status));
  for (const line of columns(facts)) deps.out(`  ${line}`);
  showSuspensions(result.suspensions, now, deps);
  if (result.status === "completed") showObjectResult(result.returnValue, deps);
  showResources(result.resources, deps);
  showTimeline(timeline, deps);
  return result;
}

// What the run is waiting for, and where to go and act on it — the token
// itself is an implementation detail of the hook it parked on.
function showSuspensions(
  suspensions: readonly RunListSuspension[],
  now: Date,
  deps: ServiceDeps,
): void {
  if (suspensions.length === 0) return;
  deps.out("");
  deps.out(heading("Waiting"));
  for (const suspension of suspensions) {
    deps.out(`  ${suspensionLine(suspension)}`);
    // Only the single-run route reads the providers, so these are absent
    // whenever GitHub could not be asked.
    const gate =
      suspension.headSha === undefined
        ? []
        : [
            ["head sha", suspension.headSha],
            ["CI", `${suspension.ci}`],
            ["approval", `${suspension.approval}`],
            ["draft", suspension.draft === true ? "yes" : "no"],
            ["mergeable state", `${suspension.mergeState}`],
            ["blocker", `${suspension.blocker}`],
          ];
    const wake = suspension.lastWake;
    const wakeRow =
      wake === undefined
        ? []
        : [["last wake", `${wake.kind}, ${age(wake.at, now)} ago ${detail(wake.at)}`]];
    for (const line of columns([...gate, ...wakeRow])) deps.out(`    ${line}`);
    if (suspension.question !== undefined) {
      deps.out("  asked:");
      for (const line of suspension.question.split("\n")) deps.out(`    ${line}`);
    }
  }
}

const RESULT_KEY_LIMIT = 12;

function scalarResult(result: StatusResult): string[][] {
  const value = result.returnValue;
  if (result.status !== "completed" || value === undefined || value === null) return [];
  if (typeof value === "object" && !Array.isArray(value)) return [];
  return [["result", formatResultValue(value)]];
}

function showObjectResult(value: unknown, deps: ServiceDeps): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const entries = Object.entries(value);
  deps.out("");
  deps.out(heading("Result"));
  const rows = entries
    .slice(0, RESULT_KEY_LIMIT)
    .map(([key, entryValue]) => [singleLine(key), formatResultValue(entryValue)]);
  for (const line of columns(rows)) deps.out(`  ${line}`);
  const omitted = entries.length - RESULT_KEY_LIMIT;
  if (omitted > 0) deps.out(`  ${note(`… ${omitted} more ${omitted === 1 ? "key" : "keys"}`)}`);
}

function showResources(resources: readonly ResourceRecord[], deps: ServiceDeps): void {
  if (resources.length === 0) return;
  deps.out("");
  deps.out(heading("Resources"));
  const rows = resources.flatMap((resource) => {
    const identity = displayPath(singleLine(resource.identity));
    const where = displayPath(singleLine(resource.url));
    return [
      [singleLine(resource.kind), tone(resource.state), identity],
      ...(where === identity ? [] : [["", "", where]]),
      ...(resource.reason === null ? [] : [["", "", note(singleLine(resource.reason))]]),
    ];
  });
  for (const line of formatTable(["KIND", "STATE", "RESOURCE"], rows)) deps.out(`  ${line}`);
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
    deps.out("");
    deps.out(`timeline unavailable: ${timeline.error}`);
    return;
  }
  const steps = timeline.steps ?? [];
  if (steps.length > 0) {
    deps.out("");
    deps.out(heading("Steps"));
    for (const line of formatTable(
      ["STEP", "STATUS", "ATTEMPT", "STARTED", "TOOK", "ERROR"],
      steps.map((step) => [
        step.name,
        tone(step.status),
        String(step.attempt),
        step.startedAt ?? "-",
        took(step),
        firstLine(step.error),
      ]),
    )) {
      deps.out(`  ${line}`);
    }
  }
  // The queue gave up on these, so nothing is coming to move the run. jigs
  // prints the requeue rather than running it: what to do about a job that
  // failed three times is the operator's call.
  const deadJobs = timeline.deadJobs ?? [];
  if (deadJobs.length === 0) return;
  deps.out("");
  deps.out(heading("Dead jobs"));
  for (const job of deadJobs) {
    const requeue = `select graphile_worker.reschedule_jobs(array[${job.id}]::bigint[], run_at := now(), attempts := 0)`;
    for (const line of indent([
      `job ${job.id} (${job.task}) gave up after ${job.attempts} attempts: ${firstLine(job.lastError)}`,
      ...hint("to requeue it, run in the World database:", requeue),
    ])) {
      deps.out(line);
    }
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
