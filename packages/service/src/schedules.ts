// The service's clock: one croner job per declared schedule, each firing
// through the same trigger path a `jigs run` takes. croner computes every
// next occurrence from now, so a tick missed while the service was down is
// skipped by construction — there is no catch-up.

import { Cron } from "croner";
import { type Check, failedCheck, formatFailures } from "jigs/checks";
import type { z } from "zod";
import type { Factory, Schedule } from "./factory";
import {
  listRuns,
  type RunRow,
  scheduleTriggerId,
  scheduleTriggerLabel,
  TERMINAL_RUN_STATUSES,
} from "./runs";
import { type StartRunResult, startRun } from "./trigger";

// Five fields, minute to day-of-week: croner's default mode would also
// accept a seconds field, and a schedule that fires sixty times an hour
// because a field shifted is not a mistake to leave available.
const CRON_MODE = "5-part";

export interface ScheduleView {
  name: string;
  pipeline: string;
  cron: string;
  next: string | null;
  active: string | null;
}

export interface ScheduleDeps {
  startRun?: typeof startRun;
  listRuns?: typeof listRuns;
  log?: (line: string) => void;
}

/**
 * Starts a job per valid schedule and returns them. A malformed schedule is
 * logged with its repair and left unscheduled: the service still starts, and
 * `jigs doctor` reports the same failure on demand.
 */
export function startSchedules(
  factory: Factory,
  deps: ScheduleDeps = {},
): Cron[] {
  const log = deps.log ?? console.log;
  const jobs: Cron[] = [];
  for (const [name, schedule] of Object.entries(factory.schedules ?? {})) {
    const problem = scheduleProblem(factory, name, schedule);
    if (problem !== null) {
      log(`[schedule] ${name} not scheduled: ${problem.reason}`);
      log(`  → ${problem.repair}`);
      continue;
    }
    const job = new Cron(schedule.cron, { name, mode: CRON_MODE }, () =>
      fireSchedule(factory, name, schedule, deps),
    );
    jobs.push(job);
    log(
      `[schedule] ${name} scheduled: ${schedule.cron} → ${schedule.pipeline}, next ${isoOrNever(job.nextRun())}`,
    );
  }
  return jobs;
}

/**
 * One fire: skip while a run of this schedule is still active, then trigger
 * the pipeline like any other launch. Nothing here throws — a ticker
 * callback that rejects takes the service down with it.
 */
export async function fireSchedule(
  factory: Factory,
  name: string,
  schedule: Schedule,
  deps: ScheduleDeps = {},
): Promise<void> {
  const log = deps.log ?? console.log;
  try {
    const rows = await (deps.listRuns ?? listRuns)(factory);
    const active = activeRunId(rows, name);
    if (active !== null) {
      log(`[schedule] ${name} skipped: run ${active} is still active`);
      return;
    }
    const result = await (deps.startRun ?? startRun)(
      factory,
      schedule.pipeline,
      schedule.inputs,
      scheduleTriggerId(name, new Date()),
    );
    if (result.kind === "started") {
      log(
        `[schedule] ${name} fired: run ${result.runId} of ${schedule.pipeline}`,
      );
      return;
    }
    log(`[schedule] ${name} not fired: ${describeFailure(result)}`);
  } catch (err) {
    log(`[schedule] ${name} failed: ${String(err)}`);
  }
}

/** What `GET /api/schedules` answers with. `next` is recomputed from the
 *  pattern rather than read off a job, so it is the same answer whether the
 *  schedule is running here or was refused at startup. */
export async function listSchedules(
  factory: Factory,
  deps: ScheduleDeps = {},
): Promise<ScheduleView[]> {
  const declared = Object.entries(factory.schedules ?? {});
  if (declared.length === 0) return [];
  const rows = await (deps.listRuns ?? listRuns)(factory);
  return declared.map(([name, schedule]) => ({
    name,
    pipeline: schedule.pipeline,
    cron: schedule.cron,
    next: nextOccurrence(schedule.cron),
    active: activeRunId(rows, name),
  }));
}

/** Doctor's half: the same three validations the ticker refuses on, one
 *  check per schedule. */
export function scheduleChecks(factory: Factory): Check[] {
  return Object.entries(factory.schedules ?? {}).map(([name, schedule]) => {
    const id = `schedule.${name}`;
    const label = `schedule ${name}`;
    const problem = scheduleProblem(factory, name, schedule);
    return problem === null
      ? { id, label, run: async (): Promise<{ ok: true }> => ({ ok: true }) }
      : failedCheck(id, label, problem.reason, problem.repair);
  });
}

interface ScheduleProblem {
  reason: string;
  repair: string;
}

function scheduleProblem(
  factory: Factory,
  name: string,
  schedule: Schedule,
): ScheduleProblem | null {
  // The tick is appended to the name with a ":", and both the trigger column
  // and the overlap skip read the name back by splitting on the first one — so
  // a name carrying its own would answer for another schedule's runs.
  if (name.includes(":")) {
    return {
      reason: `schedule name "${name}" contains ":"`,
      repair: `rename the "${name}" schedule in jigs.config.ts to a name without ":" — it is what a run's trigger id is read back out of`,
    };
  }
  const entry = factory.pipelines[schedule.pipeline];
  if (!entry) {
    return {
      reason: `pipeline "${schedule.pipeline}" is not one of this factory's pipelines`,
      repair: `set schedules.${name}.pipeline in jigs.config.ts to one of: ${Object.keys(factory.pipelines).join(", ")}`,
    };
  }
  try {
    new Cron(schedule.cron, { mode: CRON_MODE });
  } catch (err) {
    return {
      reason: `cron "${schedule.cron}" is not a five-field cron expression: ${String(err)}`,
      repair: `fix schedules.${name}.cron in jigs.config.ts — five fields, minute hour day-of-month month day-of-week`,
    };
  }
  const parsed = entry.inputs.safeParse(schedule.inputs);
  if (!parsed.success) {
    return {
      reason: `inputs do not satisfy the ${schedule.pipeline} pipeline's schema: ${parsed.error.issues
        .map(
          (issue: z.core.$ZodIssue) =>
            `${issue.path.join(".") || "(root)"} ${issue.message}`,
        )
        .join("; ")}`,
      repair: `fix schedules.${name}.inputs in jigs.config.ts to satisfy the ${schedule.pipeline} pipeline's inputs`,
    };
  }
  return null;
}

function activeRunId(rows: RunRow[], name: string): string | null {
  const trigger = scheduleTriggerLabel(name);
  const active = rows.find(
    (row) => row.trigger === trigger && !TERMINAL_RUN_STATUSES.has(row.status),
  );
  return active?.runId ?? null;
}

function nextOccurrence(cron: string): string | null {
  try {
    return isoOrNull(new Cron(cron, { mode: CRON_MODE }).nextRun());
  } catch {
    return null;
  }
}

const isoOrNull = (date: Date | null) => date?.toISOString() ?? null;
const isoOrNever = (date: Date | null) => isoOrNull(date) ?? "never";

function describeFailure(result: Exclude<StartRunResult, { kind: "started" }>) {
  switch (result.kind) {
    case "preflight-failed":
      return `preflight failed\n${formatFailures(result.report)}`;
    case "invalid-ticket":
      return `invalid ticket: ${result.reason}`;
    case "unknown-pipeline":
      return `unknown pipeline (known: ${result.knownPipelines.join(", ")})`;
    case "invalid-inputs":
      return `invalid inputs: ${JSON.stringify(result.issues)}`;
  }
}
