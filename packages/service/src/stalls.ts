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

// A step in either state is work the run is still waiting on, so nothing is
// stalled while one exists.
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

interface DeadJobRow extends Omit<DeadJobView, "createdAt"> {
  createdAt: Date;
  payload: unknown;
}

// graphile's documented `jobs` view carries no payload, and the payload is the
// only thing that names the run a job belongs to.
async function deadJobRows(sql: ISql): Promise<DeadJobRow[]> {
  return await sql<DeadJobRow[]>`
    SELECT jobs.id, jobs.task_identifier AS task, jobs.attempts,
           jobs.last_error, jobs.created_at, body.payload
    FROM graphile_worker.jobs
    JOIN graphile_worker._private_jobs AS body ON body.id = jobs.id
    WHERE jobs.attempts >= jobs.max_attempts
    ORDER BY jobs.created_at
  `;
}

/** The jobs the queue has given up on, each with the run its body names. */
export async function listDeadJobs(
  sql: ISql,
): Promise<Array<DeadJobView & { runId: string | null }>> {
  return (await deadJobRows(sql)).map((row) => ({
    ...view(row),
    runId: runIdOf(row.payload),
  }));
}

export async function listRunDeadJobs(
  sql: ISql,
  runId: string,
): Promise<DeadJobView[]> {
  return (await deadJobRows(sql))
    .filter((row) => runIdOf(row.payload) === runId)
    .map(view);
}

function view({ payload: _payload, ...job }: DeadJobRow): DeadJobView {
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
