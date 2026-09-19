import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createWorld } from "@workflow/world-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { setWorld } from "workflow/runtime";
import { z } from "zod";
import type { Factory } from "../blocks/factory.ts";
import { ensureWorktreeRegistry } from "../steps/workspaces/registry.ts";
import { registrySql } from "../steps/workspaces/sql.ts";
import { createApp } from "./app.ts";

const adminUrl = new URL(
  process.env.WORKFLOW_POSTGRES_URL ?? "postgres://jigs:jigs@localhost:5439/jigs",
);
const database = `jigs_cancel_${crypto.randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${database}`;

const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
const sql = new Pool({ connectionString: testUrl.toString(), max: 1 });
const requests: Array<() => void> = [];
const server = createServer(async (req, res) => {
  await req.toArray();
  await new Promise<void>((resolve) => requests.push(resolve));
  res.writeHead(503, { "content-type": "text/plain" });
  res.end("cancel test delivery failure");
});
const fixture = {
  workflows: {
    cancelTest: { workflow: async () => undefined, inputs: z.object({}) },
  },
} satisfies Factory;
const app = createApp(fixture);

let world: ReturnType<typeof createWorld>;
let oldBaseUrl: string | undefined;
let oldPostgresUrl: string | undefined;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  execFileSync("node_modules/.bin/bootstrap", [], {
    env: { ...process.env, WORKFLOW_POSTGRES_URL: testUrl.toString() },
    stdio: "ignore",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  oldBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
  oldPostgresUrl = process.env.WORKFLOW_POSTGRES_URL;
  process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.WORKFLOW_POSTGRES_URL = testUrl.toString();
  world = createWorld({
    connectionString: testUrl.toString(),
    queueConcurrency: 1,
  });
  setWorld(world);
  await world.start();
  await ensureWorktreeRegistry(registrySql());
});

afterAll(async () => {
  for (const release of requests.splice(0)) release();
  await world?.close?.();
  await registrySql().$client.end();
  setWorld(undefined);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await sql.end();
  // pg pool.end() can resolve before PostgreSQL observes every socket close.
  // Let the server finish disconnecting instead of terminating those clients.
  await until(async () => {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1",
      [database],
    );
    return rows[0].count === 0;
  }, "cancel fixture database still has connected clients after shutdown");
  await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
  if (oldBaseUrl === undefined) delete process.env.WORKFLOW_LOCAL_BASE_URL;
  else process.env.WORKFLOW_LOCAL_BASE_URL = oldBaseUrl;
  if (oldPostgresUrl === undefined) delete process.env.WORKFLOW_POSTGRES_URL;
  else process.env.WORKFLOW_POSTGRES_URL = oldPostgresUrl;
});

async function createRun(): Promise<string> {
  const created = await world.events.create(null, {
    eventType: "run_created",
    eventData: {
      deploymentId: "postgres",
      workflowName: "cancelTest",
      input: new Uint8Array(),
      executionContext: { workflowCoreVersion: "5.0.0-beta.53", workflowVm: "node" },
    },
  });
  if (created.run === undefined) throw new Error("run_created returned no run");
  return created.run.runId;
}

async function queue(runId: string, delaySeconds?: number): Promise<string> {
  const queued = await world.queue("__wkf_workflow_cancelTest", { runId }, { delaySeconds });
  if (queued.messageId === null) throw new Error("queue returned no message id");
  return queued.messageId;
}

async function jobsFor(runId: string) {
  return (
    await sql.query<{ id: string; attempts: number; lockedAt: Date | null }>(
      `
    SELECT jobs.id, jobs.attempts, jobs.locked_at AS "lockedAt"
    FROM graphile_worker.jobs
    JOIN graphile_worker._private_jobs AS body ON body.id = jobs.id
    WHERE convert_from(decode(body.payload->>'data', 'base64'), 'LATIN1') LIKE $1
  `,
      [`%${runId}%`],
    )
  ).rows;
}

async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("the cancel endpoint removes an actual run's pending and exhausted jobs", async () => {
  const runId = await createRun();
  await queue(runId, 60);
  const exhausted = await queue(runId, 60);
  await sql.query(
    `
    UPDATE graphile_worker._private_jobs
    SET attempts = max_attempts, last_error = 'already exhausted'
    WHERE key = $1
  `,
    [exhausted],
  );

  const res = await app.request(`/api/runs/${runId}/cancel`, { method: "POST" });

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ runId, cancelled: true, deletedJobs: 2 });
  expect(await jobsFor(runId)).toHaveLength(0);
  expect(await world.runs.get(runId)).toMatchObject({ status: "cancelled" });
});

test("no worker failure is logged after an in-flight run is cancelled", async () => {
  const runId = await createRun();
  const stderr: string[] = [];
  const write = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  try {
    await queue(runId);
    await until(async () => {
      const job = (await jobsFor(runId))[0];
      return job !== undefined && job.lockedAt !== null;
    }, "job was never delivered");

    const cancelling = app.request(`/api/runs/${runId}/cancel`, { method: "POST" });
    await until(
      async () => (await world.runs.get(runId)).status === "cancelled",
      "run was never cancelled",
    );
    for (const release of requests.splice(0)) release();
    const res = await cancelling;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runId, cancelled: true, deletedJobs: 1 });
    const outputAtCancel = stderr.join("");
    expect(outputAtCancel).toContain("[Graphile Worker] Failed task");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(stderr.join("").slice(outputAtCancel.length)).not.toContain(
      "[Graphile Worker] Failed task",
    );
    expect(await jobsFor(runId)).toHaveLength(0);
  } finally {
    write.mockRestore();
  }
});
