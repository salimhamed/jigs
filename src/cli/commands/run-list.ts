import { JigsError } from "../../errors.ts";
import type { RunSuspension } from "../../run-suspension.ts";
import { type ResourceRecord, unreleased } from "../../workflow/runtime/resources.ts";
import { displayPath, formatTable, hintLines, indent, tone } from "../output.ts";
import { type ServiceDeps, serviceFetch } from "./service-client.ts";

export type RunListSuspension = RunSuspension;

export interface RunListRun {
  runId: string;
  workflow: string;
  status: string;
  trigger: string;
  ticket: string | null;
  createdAt: string;
  lastActivityAt: string;
  /** How far the run got, or null when nothing read its steps. */
  steps: number | null;
  lastStep: { name: string; status: string; at: string | null } | null;
  suspensions: RunListSuspension[];
  /** Every resource the run recorded, released ones included. */
  resources: ResourceRecord[];
}

export interface RunListSchedule {
  name: string;
  workflow: string;
  cron: string;
  next: string | null;
  active: string | null;
}

export interface RunListTrigger {
  name: string;
  workflow: string;
  source: string;
  lastEvent: string | null;
  pending: number;
  active: number;
  failed: number;
  failures: Array<{
    occurrence: string;
    at: string;
    checks: Array<{ label: string; reason: string; repair: string }>;
  }>;
}

export interface RunListResult {
  runs: RunListRun[];
  schedules: RunListSchedule[];
  triggers: RunListTrigger[];
}

export interface RunListOptions {
  json?: boolean;
  now?: Date;
}

export async function listFactoryRuns(deps: ServiceDeps): Promise<RunListResult> {
  const res = await serviceFetch(deps.serviceUrl, "/api/runs");
  if (!res.ok) {
    throw new JigsError(`status failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as RunListResult;
}

export async function showRuns(
  deps: ServiceDeps,
  options: RunListOptions = {},
): Promise<RunListResult> {
  const result = await listFactoryRuns(deps);
  // The service's own answer, verbatim: a watcher reads fields the tables
  // below only render, and a second shape here would be a second contract.
  if (options.json === true) {
    deps.out(JSON.stringify(result, null, 2));
    return result;
  }
  const now = options.now ?? new Date();

  if (result.runs.length === 0) {
    deps.out("no runs");
  } else {
    for (const line of formatTable(
      ["RUN", "WORKFLOW", "TICKET", "STATUS", "TRIGGER", "AGE", "ACTIVITY", "WAITING"],
      result.runs.map((run) => [
        run.runId,
        run.workflow,
        run.ticket ?? "-",
        tone(run.status),
        run.trigger,
        age(run.createdAt, now),
        age(run.lastActivityAt, now),
        waitingCell(run),
      ]),
    )) {
      deps.out(line);
    }
  }

  const held = result.runs.flatMap((run) => run.resources.filter(unreleased));
  if (held.length > 0) {
    deps.out("");
    for (const line of formatTable(
      ["RESOURCE", "KIND", "STATE", "RUN", "REASON"],
      held.map((resource) => [
        displayPath(resource.identity),
        resource.kind,
        tone(resource.state),
        resource.runId,
        resource.reason ?? "-",
      ]),
    )) {
      deps.out(line);
    }
  }
  if (result.schedules.length > 0) {
    deps.out("");
    for (const line of formatTable(
      ["SCHEDULE", "WORKFLOW", "CRON", "NEXT", "ACTIVE"],
      result.schedules.map((schedule) => [
        schedule.name,
        schedule.workflow,
        schedule.cron,
        schedule.next ?? "-",
        schedule.active ?? "-",
      ]),
    )) {
      deps.out(line);
    }
  }
  if (result.triggers.length > 0) {
    deps.out("");
    for (const line of formatTable(
      ["TRIGGER", "WORKFLOW", "SOURCE", "LAST EVENT", "PENDING", "ACTIVE", "FAILED"],
      result.triggers.map((trigger) => [
        trigger.name,
        trigger.workflow,
        trigger.source,
        trigger.lastEvent ?? "-",
        String(trigger.pending),
        String(trigger.active),
        String(trigger.failed),
      ]),
    )) {
      deps.out(line);
    }
    for (const line of triggerFailureLines(result.triggers)) deps.out(line);
  }
  return result;
}

// A failed occurrence is never retried, so its repair is the operator's to
// apply before the next occurrence arrives.
function triggerFailureLines(triggers: readonly RunListTrigger[]): string[] {
  return triggers.flatMap((trigger) =>
    trigger.failures.flatMap((failure) =>
      failure.checks.flatMap((check) => [
        `${tone("FAIL")} ${trigger.name} ${failure.occurrence}: ${check.label}: ${check.reason}`,
        ...indent(hintLines(check.repair)),
      ]),
    ),
  );
}

export function waitingCell(run: RunListRun): string {
  return run.suspensions.map(suspensionLine).join("; ") || "-";
}

export const suspensionLine = (suspension: RunListSuspension): string =>
  suspension.url === undefined ? suspension.reason : `${suspension.reason} → ${suspension.url}`;

export function age(at: string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(at).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
