// Graphile's documented jobs view omits the payload that identifies a run, so
// queue inspection and cancellation share this one read/decode boundary.

import { sql } from "drizzle-orm";
import type { RegistrySql } from "../steps/workspaces/registry.ts";

export interface DeadJobView {
  id: string;
  task: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

type JobRow = Omit<DeadJobView, "createdAt"> & {
  createdAt: Date | string;
  dead: boolean;
  payload: unknown;
};

export interface JobRunIds {
  dead: string[];
  live: string[];
}

async function jobRows(db: RegistrySql): Promise<JobRow[]> {
  return (
    await db.execute<JobRow>(sql`
    SELECT jobs.id, jobs.task_identifier AS task, jobs.attempts,
           jobs.attempts >= jobs.max_attempts AS dead,
           jobs.last_error AS "lastError", jobs.created_at AS "createdAt", body.payload
    FROM graphile_worker.jobs
    JOIN graphile_worker._private_jobs AS body ON body.id = jobs.id
    ORDER BY jobs.created_at
  `)
  ).rows;
}

export async function listJobRunIds(db: RegistrySql): Promise<JobRunIds> {
  const named = (await jobRows(db)).flatMap((row) => {
    const runId = runIdOf(row.payload);
    return runId === null ? [] : [{ runId, dead: row.dead }];
  });
  return {
    dead: named.filter((job) => job.dead).map((job) => job.runId),
    live: named.filter((job) => !job.dead).map((job) => job.runId),
  };
}

/** The jobs the queue gave up on for one run. */
export async function listRunDeadJobs(db: RegistrySql, runId: string): Promise<DeadJobView[]> {
  return (await jobRows(db)).filter((row) => row.dead && runIdOf(row.payload) === runId).map(view);
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
 * already in progress, so the DELETE carries the lock test itself: a worker
 * that takes a row between the scan and the statement blocks the statement on
 * the row and then fails its own predicate, leaving that delivery to finish.
 * What the DELETE leaves behind is waited on and rescanned, which also catches
 * a row the in-flight delivery enqueued after the scan. Graphile treats a lock
 * older than four hours as stale, so cancellation may remove those directly.
 * A delivery still running when the bounded wait ends asks the operator to
 * retry cancellation, which resumes from the rows that are left. */
export async function deleteRunJobs(
  db: RegistrySql,
  runId: string,
  options: DeleteRunJobsOptions = {},
): Promise<number> {
  const deadline = Date.now() + (options.maxWaitMs ?? 5_000);
  const staleLockMs = options.staleLockMs ?? GRAPHILE_STALE_LOCK_MS;
  let removed = 0;
  for (let pass = 0; ; pass += 1) {
    const ids = (await jobRows(db))
      .filter((row) => runIdOf(row.payload) === runId)
      .map((row) => row.id);
    if (ids.length === 0) return removed;
    if (pass > 0 && Date.now() >= deadline) throw new RunJobsLockedError(runId);
    const staleBefore = new Date(Date.now() - staleLockMs);
    const deleted = await db.execute<{ id: string }>(sql`
      DELETE FROM graphile_worker._private_jobs
      WHERE id = ANY(${sql.param(ids)}::bigint[])
        AND (locked_at IS NULL OR locked_at < ${staleBefore})
      RETURNING id
    `);
    removed += deleted.rows.length;
    if (deleted.rows.length < ids.length) {
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 20));
    }
  }
}

function view({ payload: _payload, dead: _dead, ...job }: JobRow): DeadJobView {
  return { ...job, createdAt: new Date(job.createdAt).toISOString() };
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
