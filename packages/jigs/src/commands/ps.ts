import { CliError } from "../errors.ts";
import { formatTable } from "../table.ts";
import { type ServiceDeps, serviceFetch } from "./service.ts";

export interface PsRun {
  runId: string;
  pipeline: string;
  status: string;
  terminal: boolean;
  trigger: string;
  createdAt: string;
}

export interface PsSchedule {
  name: string;
  pipeline: string;
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

export async function listRunsForPs(
  deps: ServiceDeps,
  now: Date = new Date(),
): Promise<PsResult> {
  const res = await serviceFetch(deps.serviceUrl, "/api/runs");
  if (!res.ok) {
    throw new CliError(`ps failed: HTTP ${res.status} ${await res.text()}`);
  }
  const result = (await res.json()) as PsResult;

  if (result.runs.length === 0) {
    deps.out("no runs");
  } else {
    for (const line of formatTable(
      ["RUN", "PIPELINE", "STATUS", "TRIGGER", "AGE"],
      result.runs.map((run) => [
        run.runId,
        run.pipeline,
        run.status,
        run.trigger,
        age(run.createdAt, now),
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
      ["SCHEDULE", "PIPELINE", "CRON", "NEXT", "ACTIVE"],
      result.schedules.map((schedule) => [
        schedule.name,
        schedule.pipeline,
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

function age(createdAt: string, now: Date): string {
  const seconds = Math.max(
    0,
    Math.round((now.getTime() - new Date(createdAt).getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
