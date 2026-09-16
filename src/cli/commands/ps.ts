import { JigsError } from "../../errors.ts";
import { outcomeNeedsAttention } from "../../run-status.ts";
import { formatTable } from "../table.ts";
import { type ServiceDeps, serviceFetch } from "./service-client.ts";

export interface PsSuspension {
  token: string;
  kind: string;
  reason: string;
  url?: string;
  question?: string;
}

export interface PsRun {
  runId: string;
  workflow: string;
  status: string;
  outcome: string | null;
  trigger: string;
  ticket: string | null;
  pullRequest: string | null;
  createdAt: string;
  lastActivityAt: string;
  steps: number;
  lastStep: { name: string; status: string; at: string | null } | null;
  suspended: boolean;
  suspensions: PsSuspension[];
}

export interface PsSchedule {
  name: string;
  workflow: string;
  cron: string;
  next: string | null;
  active: string | null;
}

export interface PsWorktree {
  path: string;
  branch: string;
  state: string;
  ownerRunId: string;
}

export interface PsResult {
  runs: PsRun[];
  worktrees: PsWorktree[];
  schedules: PsSchedule[];
}

export interface PsOptions {
  json?: boolean;
  now?: Date;
}

export async function listFactoryRuns(deps: ServiceDeps): Promise<PsResult> {
  const res = await serviceFetch(deps.serviceUrl, "/api/runs");
  if (!res.ok) {
    throw new JigsError(`ps failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as PsResult;
}

export async function showRuns(deps: ServiceDeps, options: PsOptions = {}): Promise<PsResult> {
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
      [
        "RUN",
        "WORKFLOW",
        "TICKET",
        "STATUS",
        "OUTCOME",
        "PR",
        "TRIGGER",
        "AGE",
        "ACTIVITY",
        "WAITING",
      ],
      result.runs.map((run) => [
        run.runId,
        run.workflow,
        run.ticket ?? "-",
        run.status,
        outcomeCell(run.outcome),
        run.pullRequest ?? "-",
        run.trigger,
        age(run.createdAt, now),
        age(run.lastActivityAt, now),
        waitingCell(run),
      ]),
    )) {
      deps.out(line);
    }
  }

  if (result.worktrees.length > 0) {
    deps.out("");
    // The registry's state string is printed verbatim, never filtered or
    // mapped: an abandoned-dirty worktree has to be visible here, and any
    // state jigs does not yet know about is exactly the one worth showing.
    for (const line of formatTable(
      ["WORKTREE", "BRANCH", "STATE", "RUN"],
      result.worktrees.map((worktree) => [
        worktree.path,
        worktree.branch,
        worktree.state,
        worktree.ownerRunId,
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
  return result;
}

/** A run that gave up and one that merged both read `completed`; the bang is
 *  what stops the first from passing for the second at a glance. */
export function outcomeCell(outcome: string | null): string {
  if (outcome === null) return "-";
  return outcomeNeedsAttention(outcome) ? `!${outcome}` : outcome;
}

export function waitingCell(run: PsRun): string {
  return run.suspensions.map(suspensionLine).join("; ") || "-";
}

export const suspensionLine = (suspension: PsSuspension): string =>
  suspension.url === undefined || suspension.url === ""
    ? suspension.reason
    : `${suspension.reason} → ${suspension.url}`;

export function age(at: string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(at).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
