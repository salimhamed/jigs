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

/** Delete every queued delivery for a run. A locked row is an HTTP delivery
 * already in progress: leave it present until Graphile records its outcome,
 * then delete any retry before returning. This makes a successful cancel
 * response the boundary after which no worker failure for the run can appear. */
export async function deleteRunJobs(sql: ISql, runId: string): Promise<number> {
  let count = 0;
  for (;;) {
    const rows = (await jobRows(sql)).filter((row) => runIdOf(row.payload) === runId);
    if (rows.length === 0) return count;
    const ids = rows.filter((row) => row.lockedAt === null).map((row) => row.id);
    if (ids.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      continue;
    }
    const deleted = await sql<{ id: string }[]>`
      DELETE FROM graphile_worker._private_jobs
      WHERE id = ANY(${ids}::bigint[]) AND locked_at IS NULL
      RETURNING id
    `;
    count += deleted.length;
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
