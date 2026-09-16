// Graphile's documented jobs view omits the payload that identifies a run, so
// queue inspection and cancellation share this one read/decode boundary.

import type { ISql } from "postgres";

export interface DeadJobView {
  id: string;
  task: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

interface JobRow extends Omit<DeadJobView, "createdAt"> {
  createdAt: Date;
  dead: boolean;
  lockedAt: Date | null;
  payload: unknown;
}

export interface JobRunIds {
  dead: string[];
  live: string[];
}

async function jobRows(sql: ISql): Promise<JobRow[]> {
  return await sql<JobRow[]>`
    SELECT jobs.id, jobs.task_identifier AS task, jobs.attempts,
           jobs.attempts >= jobs.max_attempts AS dead,
           jobs.last_error, jobs.created_at, jobs.locked_at, body.payload
    FROM graphile_worker.jobs
    JOIN graphile_worker._private_jobs AS body ON body.id = jobs.id
    ORDER BY jobs.created_at
  `;
}

async function jobRowsById(sql: ISql, ids: readonly string[]): Promise<JobRow[]> {
  return await sql<JobRow[]>`
    SELECT jobs.id, jobs.task_identifier AS task, jobs.attempts,
           jobs.attempts >= jobs.max_attempts AS dead,
           jobs.last_error, jobs.created_at, jobs.locked_at, body.payload
    FROM graphile_worker.jobs
    JOIN graphile_worker._private_jobs AS body ON body.id = jobs.id
    WHERE jobs.id = ANY(${ids}::bigint[])
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
export async function listRunDeadJobs(sql: ISql, runId: string): Promise<DeadJobView[]> {
  return (await jobRows(sql)).filter((row) => row.dead && runIdOf(row.payload) === runId).map(view);
}

export class RunJobsLockedError extends Error {
  constructor(runId: string) {
    super(`queue jobs for ${runId} are still running; retry cancellation`);
    this.name = "RunJobsLockedError";
  }
}

interface DeleteRunJobsOptions {
  maxWaitMs?: number;
  pollMs?: number;
  staleLockMs?: number;
}

const GRAPHILE_STALE_LOCK_MS = 4 * 60 * 60 * 1000;

/** Delete every queued delivery for a run. A fresh lock is an HTTP delivery
 * already in progress: wait briefly for Graphile to record its outcome, then
 * delete every remaining row in one statement. Graphile itself treats a lock
 * older than four hours as stale, so cancellation may remove those directly.
 * A still-active delivery after the bounded wait leaves every row untouched
 * and asks the operator to retry cancellation. */
export async function deleteRunJobs(
  sql: ISql,
  runId: string,
  options: DeleteRunJobsOptions = {},
): Promise<number> {
  const initial = (await jobRows(sql)).filter((row) => runIdOf(row.payload) === runId);
  const ids = initial.map((row) => row.id);
  if (ids.length === 0) return 0;
  const deadline = Date.now() + (options.maxWaitMs ?? 5_000);
  const staleLockMs = options.staleLockMs ?? GRAPHILE_STALE_LOCK_MS;
  for (;;) {
    const rows = await jobRowsById(sql, ids);
    if (rows.length === 0) return 0;
    const staleBefore = Date.now() - staleLockMs;
    const active = rows.some(
      (row) => row.lockedAt !== null && row.lockedAt.getTime() > staleBefore,
    );
    if (!active) {
      const deleted = await sql<{ id: string }[]>`
        DELETE FROM graphile_worker._private_jobs
        WHERE id = ANY(${rows.map((row) => row.id)}::bigint[])
        RETURNING id
      `;
      return deleted.length;
    }
    if (Date.now() >= deadline) throw new RunJobsLockedError(runId);
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 20));
  }
}

function view({
  payload: _payload,
  dead: _dead,
  lockedAt: _lockedAt,
  ...job
}: JobRow): DeadJobView {
  return { ...job, createdAt: job.createdAt.toISOString() };
}

// The run id travels in the queue message body, which Graphile stores
// base64-encoded inside the job payload. It is an ASCII ULID whichever way the
// transport serialized that body, so it reads back out of the raw bytes.
const RUN_ID_IN_BODY = /wrun_[0-9A-HJKMNP-TV-Z]{26}/;

function runIdOf(payload: unknown): string | null {
  const data = (payload as { data?: unknown } | null)?.data;
  if (typeof data !== "string") return null;
  const body = Buffer.from(data, "base64").toString("latin1");
  return RUN_ID_IN_BODY.exec(body)?.[0] ?? null;
}
