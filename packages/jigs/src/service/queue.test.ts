import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { expect, test } from "vitest";
import { listRunDeadJobs } from "./queue.ts";

const RUN_A = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
const RUN_B = "wrun_01K3ANC1P0R4S6TXZ8B3F5G7HJ";

const payloadFor = (runId: string) => ({
  data: Buffer.from(`\x82\x01x\x1f${runId}`, "latin1").toString("base64"),
});

const fakeSql = (rows: unknown[]) => drizzle({ query: async () => ({ rows }) } as unknown as Pool);

const job = (over: Record<string, unknown> = {}) => ({
  id: "4128",
  task: "jigs:workflow",
  attempts: 3,
  dead: true,
  lastError: "Queue execution failed (404): Not Found",
  createdAt: new Date("2026-09-04T10:00:00.000Z"),
  payload: payloadFor(RUN_A),
  ...over,
});

test("a dead job whose payload names no run belongs to no run", async () => {
  expect(await listRunDeadJobs(fakeSql([job({ payload: null })]), RUN_A)).toEqual([]);
});

test("the per-run listing keeps that run's dead jobs, and drops its internal columns", async () => {
  const jobs = await listRunDeadJobs(
    fakeSql([
      job({ id: "4127", dead: false, payload: payloadFor(RUN_B) }),
      job({ id: "4129", payload: payloadFor(RUN_B) }),
      job(),
    ]),
    RUN_B,
  );
  expect(jobs.map((row) => row.id)).toEqual(["4129"]);
  expect(jobs[0]).not.toHaveProperty("payload");
  expect(jobs[0]).not.toHaveProperty("dead");
});
