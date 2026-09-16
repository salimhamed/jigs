import postgres from "postgres";
import { afterAll, expect, test } from "vitest";
import { deleteRunJobs, listJobRunIds } from "./stalls.ts";

const sql = postgres(
  process.env.WORKFLOW_POSTGRES_URL ?? "postgres://jigs:jigs@localhost:5439/jigs",
  { max: 1, transform: postgres.camel },
);

const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
const OTHER_RUN = "wrun_01K3ANC1P0R4S6TXZ8B3F5G7HJ";
const keyPrefix = `jigs-cancel-live-${crypto.randomUUID()}`;

const payloadFor = (runId: string) => ({
  data: Buffer.from(`\x82\x01x\x1f${runId}`, "latin1").toString("base64"),
});

async function addJob(runId: string, suffix: string): Promise<string> {
  const [job] = await sql<{ id: string }[]>`
    SELECT id
    FROM graphile_worker.add_job(
      ${`${keyPrefix}:${suffix}`},
      ${sql.json(payloadFor(runId))}::json,
      job_key := ${`${keyPrefix}:${suffix}`}
    )
  `;
  if (job === undefined) throw new Error("graphile_worker.add_job returned no row");
  return job.id;
}

afterAll(async () => {
  await sql`
    DELETE FROM graphile_worker._private_jobs
    WHERE key LIKE ${`${keyPrefix}:%`}
  `;
  await sql.end();
});

test("deleting a run's jobs removes its pending and exhausted rows only", async () => {
  const pendingId = await addJob(RUN, "pending");
  const exhaustedId = await addJob(RUN, "exhausted");
  await addJob(OTHER_RUN, "other");
  await sql`
    UPDATE graphile_worker._private_jobs
    SET attempts = max_attempts, last_error = 'cancelled run'
    WHERE id = ${exhaustedId}
  `;

  expect(await deleteRunJobs(sql, RUN)).toBe(2);
  const remaining = await listJobRunIds(sql);
  expect([...remaining.dead, ...remaining.live]).not.toContain(RUN);
  expect([...remaining.dead, ...remaining.live]).toContain(OTHER_RUN);

  const targetRows = await sql`
    SELECT id FROM graphile_worker.jobs
    WHERE id IN (${pendingId}, ${exhaustedId})
  `;
  expect(targetRows).toHaveLength(0);
});
