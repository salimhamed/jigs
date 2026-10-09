// Start and inspect the recurring schedules declared by a factory.

import { Cron } from "croner";
import { type Check, failedCheck, formatFailures } from "../checks/index.ts";
import { plainHint } from "../errors.ts";
import { finished } from "../steps/runtime/run-state.ts";
import type { Factory, Schedule } from "../workflow/factory.ts";
import { type ConfigProblem, issues } from "./event-triggers/validate.ts";
import { type StartRunResult, startRun } from "./launch.ts";
import { listRuns, type RunRow, scheduleTriggerId, scheduleTriggerLabel } from "./runs.ts";
import { onShutdown } from "./shutdown.ts";

// Five fields, minute to day-of-week: croner's default mode would also
// accept a seconds field, and a schedule that fires sixty times an hour
// because a field shifted is not a mistake to leave available.
const CRON_MODE = "5-part";

/** Operator-facing state for one declared recurring schedule. */
export interface ScheduleView {
  name: string;
  state: "active" | "inactive";
  workflow: string;
  cron: string;
  next: string | null;
  active: string | null;
}

/** Injectable run operations and logging used by the schedule service. */
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
export function startSchedules(factory: Factory, deps: ScheduleDeps = {}): Cron[] {
  const log = deps.log ?? console.log;
  const jobs: Cron[] = [];
  for (const [name, schedule] of Object.entries(factory.schedules ?? {})) {
    const problem = scheduleProblem(factory, name, schedule);
    if (problem !== null) {
      log(`[schedule] ${name} not scheduled: ${problem.reason}`);
      log(plainHint(problem.repair));
      continue;
    }
    const job = new Cron(schedule.cron, { name, mode: CRON_MODE }, () =>
      fireSchedule(factory, name, schedule, deps),
    );
    jobs.push(job);
    log(
      `[schedule] ${name} scheduled: ${schedule.cron} → ${schedule.workflow}, next ${isoOrNever(job.nextRun())}`,
    );
  }
  // A tick that lands mid-drain would trigger a run into a queue that is
  // closing under it. One closer per call, and the generated plugin calls this
  // once per process.
  onShutdown(() => {
    for (const job of jobs) job.stop();
  });
  return jobs;
}

/**
 * One fire: skip while a run of this schedule is still active, then trigger
 * the workflow like any other launch. Nothing here throws — a ticker
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
      schedule.workflow,
      schedule.inputs,
      scheduleTriggerId(name, new Date()),
    );
    if (result.kind === "started") {
      log(`[schedule] ${name} fired: run ${result.runId} of ${schedule.workflow}`);
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
    state: schedule.active ? "active" : "inactive",
    workflow: schedule.workflow,
    cron: schedule.cron,
    next: schedule.active ? nextOccurrence(schedule.cron) : null,
    active: activeRunId(rows, name),
  }));
}

/** Doctor's half: the same cron and inputs validations the ticker refuses on,
 *  one check per schedule. */
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

function scheduleProblem(factory: Factory, name: string, schedule: Schedule): ConfigProblem | null {
  const entry = factory.workflows[schedule.workflow] as Factory["workflows"][string];
  try {
    new Cron(schedule.cron, { mode: CRON_MODE });
  } catch (err) {
    return {
      reason: `cron "${schedule.cron}" is not a five-field cron expression: ${String(err)}`,
      repair: `fix schedules.${name}.cron in jigs.config.ts\nit takes five fields: minute hour day-of-month month day-of-week`,
    };
  }
  const parsed = entry.inputs.safeParse(schedule.inputs);
  if (!parsed.success) {
    return {
      reason: `inputs do not satisfy the ${schedule.workflow} workflow's schema: ${issues(parsed.error.issues)}`,
      repair: `fix schedules.${name}.inputs in jigs.config.ts to satisfy the ${schedule.workflow} workflow's inputs`,
    };
  }
  return null;
}

function activeRunId(rows: RunRow[], name: string): string | null {
  const trigger = scheduleTriggerLabel(name);
  const active = rows.find((row) => row.trigger === trigger && !finished(row));
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
    case "unknown-workflow":
      return `unknown workflow (known: ${result.knownWorkflows.join(", ")})`;
    case "invalid-inputs":
      return `invalid inputs: ${JSON.stringify(result.issues)}`;
  }
}
