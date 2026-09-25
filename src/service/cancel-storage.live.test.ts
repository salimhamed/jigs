// Storage/transport scope: these focused fixtures drive World events through a
// minimal HTTP consumer. The compiled-factory E2E suite owns generated runtime
// behavior, turbo races, and user-visible cancellation assertions.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createWorld } from "@workflow/world-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { setWorld } from "workflow/runtime";
import { z } from "zod";
import { ensureWorktreeRegistry } from "../steps/workspaces/registry.ts";
import { registrySql } from "../steps/workspaces/sql.ts";
import type { Factory } from "../workflow/factory.ts";
import { createApp } from "./app.ts";
import { listJobRunIds, listRunDeadJobs } from "./queue.ts";

const adminUrl = new URL(
  process.env.WORKFLOW_POSTGRES_URL ?? "postgres://jigs:jigs@localhost:5439/jigs",
);
const database = `jigs_cancel_${crypto.randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${database}`;

const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
const sql = new Pool({ connectionString: testUrl.toString(), max: 1 });
const deliveries = new Map<string, number>();
const deliveryHandlers = new Map<string, () => Promise<void>>();
const server = createServer(async (req, res) => {
  const body = JSON.parse(Buffer.concat(await req.toArray()).toString()) as { runId: string };
  deliveries.set(body.runId, (deliveries.get(body.runId) ?? 0) + 1);
  try {
    await deliveryHandlers.get(body.runId)?.();
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(error instanceof Error ? error.message : String(error));
  }
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
  deliveryHandlers.clear();
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

async function createRun(started = false): Promise<string> {
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
  if (started) await world.events.create(created.run.runId, { eventType: "run_started" });
  return created.run.runId;
}

function createHook(runId: string, token: string, tokenRetentionUntil?: Date) {
  return world.events.create(runId, {
    eventType: "hook_created",
    correlationId: `hook_${crypto.randomUUID()}`,
    eventData: { token, ...(tokenRetentionUntil ? { tokenRetentionUntil } : {}) },
  });
}

async function createRunningStep(runId: string): Promise<string> {
  const stepId = `step_${crypto.randomUUID()}`;
  await world.events.create(runId, {
    eventType: "step_created",
    correlationId: stepId,
    eventData: { stepName: "external-effect", input: new Uint8Array() },
  });
  await world.events.create(runId, {
    eventType: "step_started",
    correlationId: stepId,
  });
  return stepId;
}

async function queue(runId: string, delaySeconds?: number): Promise<string> {
  const queued = await world.queue("__wkf_workflow_cancelTest", { runId }, { delaySeconds });
  if (queued.messageId === null) throw new Error("queue returned no message id");
  return queued.messageId;
}

interface JobView {
  key: string;
  attempts: number;
  maxAttempts: number;
  lockedAt: Date | null;
  runAt: Date;
  lastError: string | null;
}

async function jobsFor(runId: string): Promise<JobView[]> {
  return (
    await sql.query<JobView>(
      `
    SELECT body.key, body.attempts, body.max_attempts AS "maxAttempts",
           body.locked_at AS "lockedAt", body.run_at AS "runAt",
           body.last_error AS "lastError"
    FROM graphile_worker._private_jobs AS body
    WHERE convert_from(decode(body.payload->>'data', 'base64'), 'LATIN1') LIKE $1
    ORDER BY body.created_at
  `,
      [`%${runId}%`],
    )
  ).rows;
}

async function exhaust(messageId: string): Promise<void> {
  await sql.query(
    `
    UPDATE graphile_worker._private_jobs
    SET attempts = max_attempts, last_error = 'already exhausted'
    WHERE key = $1
  `,
    [messageId],
  );
}

async function wake(messageId: string): Promise<void> {
  await sql.query("UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = $1", [
    messageId,
  ]);
}

async function cancel(runId: string) {
  return app.request(`/api/runs/${runId}/cancel`, { method: "POST" });
}

async function eventsFor(runId: string) {
  return (await world.events.list({ runId, resolveData: "none" })).data;
}

async function until(
  check: () => Promise<boolean> | boolean,
  message: string,
  timeout = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a pending delivery is consumed after cancellation without workflow progress or retry", async () => {
  const blocker = await createRun();
  const blockerRelease = deferred();
  deliveryHandlers.set(blocker, () => blockerRelease.promise);
  await queue(blocker);
  await until(() => deliveries.get(blocker) === 1, "blocker was never delivered");

  const runId = await createRun();
  const token = `claim:${crypto.randomUUID()}`;
  await createHook(runId, token);
  let rejectedProgress = 0;
  deliveryHandlers.set(runId, async () => {
    try {
      await world.events.create(runId, {
        eventType: "step_created",
        correlationId: `step_${crypto.randomUUID()}`,
        eventData: { stepName: "must-not-run", input: new Uint8Array() },
      });
    } catch {
      rejectedProgress++;
    }
  });
  await queue(runId);
  await until(async () => (await jobsFor(runId)).length === 1, "pending job was not stored");

  const response = await cancel(runId);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    runId,
    cancelled: true,
    releasedTokens: [token],
    retainedTokens: [],
    worktrees: [],
  });
  expect(await jobsFor(runId)).toHaveLength(1);
  expect(deliveries.get(runId) ?? 0).toBe(0);

  const replacementRunId = await createRun();
  const replacement = await createHook(replacementRunId, token);
  expect(replacement.event).toMatchObject({ eventType: "hook_created" });

  blockerRelease.resolve();
  await until(() => deliveries.get(runId) === 1, "cancelled pending job was not consumed");
  await until(async () => (await jobsFor(runId)).length === 0, "consumed job remained queued");
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(deliveries.get(runId)).toBe(1);
  expect(rejectedProgress).toBe(1);
  expect((await eventsFor(runId)).filter((event) => event.eventType === "step_created")).toEqual(
    [],
  );
  expect(await world.runs.get(runId)).toMatchObject({ status: "cancelled" });
});

test("delayed and exhausted deliveries remain visible and do not retry after cancellation", async () => {
  const runId = await createRun();
  let rejectedProgress = 0;
  deliveryHandlers.set(runId, async () => {
    try {
      await world.events.create(runId, { eventType: "run_started" });
    } catch {
      rejectedProgress++;
    }
  });
  const delayed = await queue(runId, 60);
  const exhausted = await queue(runId, 60);
  await exhaust(exhausted);

  const first = await cancel(runId);
  const second = await cancel(runId);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(await first.json()).toMatchObject({ cancelled: true });
  expect(await second.json()).toMatchObject({ cancelled: true });
  expect(
    (await eventsFor(runId)).filter((event) => event.eventType === "run_cancelled"),
  ).toHaveLength(1);
  expect(await jobsFor(runId)).toHaveLength(2);
  expect(await listJobRunIds(registrySql())).toMatchObject({ dead: [runId], live: [runId] });
  expect(await listRunDeadJobs(registrySql(), runId)).toHaveLength(1);

  await wake(delayed);
  await until(() => deliveries.get(runId) === 1, "cancelled delayed job was not consumed");
  await until(async () => (await jobsFor(runId)).length === 1, "delayed job remained queued");
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(deliveries.get(runId)).toBe(1);
  expect(rejectedProgress).toBe(1);
  expect(await jobsFor(runId)).toEqual([
    expect.objectContaining({
      key: exhausted,
      attempts: expect.any(Number),
      lastError: "already exhausted",
    }),
  ]);
  expect((await jobsFor(runId))[0]?.attempts).toBe((await jobsFor(runId))[0]?.maxAttempts);
  expect((await eventsFor(runId)).filter((event) => event.eventType === "run_started")).toEqual([]);
});

test("an active step may finish its effect after cancellation but cannot advance the workflow", async () => {
  const runId = await createRun(true);
  const stepId = await createRunningStep(runId);
  const entered = deferred();
  const release = deferred();
  let externalEffects = 0;
  let rejectedSuccessor = 0;
  deliveryHandlers.set(runId, async () => {
    entered.resolve();
    await release.promise;
    externalEffects++;
    await world.events.create(runId, {
      eventType: "step_completed",
      correlationId: stepId,
      eventData: { result: new Uint8Array() },
    });
    try {
      await world.events.create(runId, {
        eventType: "step_created",
        correlationId: `step_${crypto.randomUUID()}`,
        eventData: { stepName: "successor", input: new Uint8Array() },
      });
    } catch {
      rejectedSuccessor++;
    }
  });
  await queue(runId);
  await entered.promise;
  await until(
    async () => (await jobsFor(runId))[0]?.lockedAt !== null,
    "active delivery was never locked",
  );

  const response = await cancel(runId);
  expect(response.status).toBe(200);
  expect((await jobsFor(runId))[0]?.lockedAt).not.toBeNull();
  expect(externalEffects).toBe(0);
  release.resolve();
  await until(async () => (await jobsFor(runId)).length === 0, "active job was not consumed");

  const events = await eventsFor(runId);
  expect(externalEffects).toBe(1);
  expect(deliveries.get(runId)).toBe(1);
  expect(rejectedSuccessor).toBe(1);
  expect(events.filter((event) => event.eventType === "step_completed")).toHaveLength(1);
  expect(events.filter((event) => event.eventType === "step_created")).toHaveLength(1);
  expect(await world.runs.get(runId)).toMatchObject({ status: "cancelled" });
});

test("cancellation racing completion returns the winning terminal state without a server error", async () => {
  const runId = await createRun(true);
  const [cancelled, completed] = await Promise.allSettled([
    cancel(runId),
    world.events.create(runId, {
      eventType: "run_completed",
      eventData: { output: new Uint8Array() },
    }),
  ]);

  expect(cancelled.status).toBe("fulfilled");
  if (cancelled.status !== "fulfilled") throw cancelled.reason;
  expect([200, 409]).toContain(cancelled.value.status);
  const run = await world.runs.get(runId);
  expect(["cancelled", "completed"]).toContain(run.status);
  const terminals = (await eventsFor(runId)).filter((event) =>
    ["run_cancelled", "run_completed"].includes(event.eventType),
  );
  expect(terminals).toHaveLength(1);
  if (completed.status === "fulfilled") expect(run.status).toBe("completed");

  const repeated = await cancel(runId);
  expect(repeated.status).toBe(run.status === "cancelled" ? 200 : 409);
});

test("a minimum-retention hook stays owned after cancellation and is reported precisely", async () => {
  const runId = await createRun();
  const token = `retained:${crypto.randomUUID()}`;
  await createHook(runId, token, new Date(Date.now() + 60_000));

  const response = await cancel(runId);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    releasedTokens: [],
    retainedTokens: [token],
  });
  expect(await world.hooks.getByToken(token)).toMatchObject({ runId, token });

  const replacementRunId = await createRun();
  const conflict = await createHook(replacementRunId, token);
  expect(conflict.event).toMatchObject({
    eventType: "hook_conflict",
    eventData: { token, conflictingRunId: runId },
  });
});
