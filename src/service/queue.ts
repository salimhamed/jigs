// Graphile's documented jobs view omits the payload that identifies a run, so
// read-only stall diagnosis owns this small private-schema adapter.

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
