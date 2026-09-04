// What a stall looks like from outside the run: the steps the World recorded,
// and the queue jobs graphile gave up on. The second half is the one nothing
// else can see — a resume job dead after its retries leaves the run `running`
// with no step in flight and nothing coming to move it.

import type { ISql } from "postgres";
import { getWorld } from "workflow/runtime";

export interface StepView {
  name: string;
  status: string;
  attempt: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface DeadJobView {
  id: string;
  task: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

const ACTIVE_STEP_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "pending",
]);

/** The steps a run recorded, oldest first. The World's own listing sorts by
 *  step id, which is only creation order while the ids are ULIDs. */
export async function listRunSteps(runId: string): Promise<StepView[]> {
  const page = await getWorld().steps.list({
    runId,
    resolveData: "none",
    pagination: { limit: 1000 },
  });
  return [...page.data]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((step) => ({
      name: step.stepName,
      status: step.status,
      attempt: step.attempt,
      startedAt: iso(step.startedAt),
      completedAt: iso(step.completedAt),
      error: step.error?.message ?? null,
    }));
}

/** Which of these runs still has a step in flight. */
export async function runsWithActiveStep(runIds: string[]): Promise<string[]> {
  const busy = await Promise.all(
    runIds.map(async (runId) => {
      const steps = await listRunSteps(runId);
      return steps.some((step) => ACTIVE_STEP_STATUSES.has(step.status))
        ? runId
        : null;
    }),
  );
  return busy.filter((runId): runId is string => runId !== null);
}

interface JobRow extends Omit<DeadJobView, "createdAt"> {
  createdAt: Date;
  dead: boolean;
  payload: unknown;
}

/** Which runs the queue holds a dead job for, and which it still holds a live
 *  one for. A dead row outlives its own recovery — a requeue and the World's
 *  own restart reconciliation both add a job rather than clearing it — so only
 *  the two answers together say whether anything is still coming. */
export interface JobRunIds {
  dead: string[];
  live: string[];
}

// graphile's documented `jobs` view carries no payload, and the payload is the
// only thing that names the run a job belongs to.
async function jobRows(sql: ISql): Promise<JobRow[]> {
  return await sql<JobRow[]>`
    SELECT jobs.id, jobs.task_identifier AS task, jobs.attempts,
           jobs.attempts >= jobs.max_attempts AS dead,
           jobs.last_error, jobs.created_at, body.payload
    FROM graphile_worker.jobs
    JOIN graphile_worker._private_jobs AS body ON body.id = jobs.id
    ORDER BY jobs.created_at
  `;
}

export async function listJobRunIds(sql: ISql): Promise<JobRunIds> {
  const named = (await jobRows(sql)).flatMap((row) => {
    const runId = runIdOf(row.payload);
    return runId === null ? [] : [{ runId, dead: row.dead }];
  });
  return {
    dead: named.filter((job) => job.dead).map((job) => job.runId),
    live: named.filter((job) => !job.dead).map((job) => job.runId),
  };
}

/** The jobs the queue gave up on for one run. */
export async function listRunDeadJobs(
  sql: ISql,
  runId: string,
): Promise<DeadJobView[]> {
  return (await jobRows(sql))
    .filter((row) => row.dead && runIdOf(row.payload) === runId)
    .map(view);
}

function view({ payload: _payload, dead: _dead, ...job }: JobRow): DeadJobView {
  return { ...job, createdAt: job.createdAt.toISOString() };
}

// The run id travels in the queue message body, which graphile stores
// base64-encoded inside the job payload. It is an ASCII ULID whichever way the
// transport serialized that body, so it reads back out of the raw bytes.
const RUN_ID_IN_BODY = /wrun_[0-9A-HJKMNP-TV-Z]{26}/;

function runIdOf(payload: unknown): string | null {
  const data = (payload as { data?: unknown } | null)?.data;
  if (typeof data !== "string") return null;
  const body = Buffer.from(data, "base64").toString("latin1");
  return RUN_ID_IN_BODY.exec(body)?.[0] ?? null;
}

const iso = (at: Date | undefined) => at?.toISOString() ?? null;
