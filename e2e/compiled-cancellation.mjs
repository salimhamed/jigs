import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const POLL_MS = 25;
const TIMEOUT_MS = 30_000;
const SERVICE_TIMEOUT_MS = 90_000;
const DRAIN_MS = 1_000;

const fixtureSource = `import { appendFileSync, existsSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import type { WorkflowEntry, WorkflowInputs } from "@jigs-ai/jigs";
import { createRunDirectory } from "#jigs";
import { RetryableError, sleep } from "workflow";
import { z } from "zod";

export const cancelE2eInputs = z.object({
  gate: z.string(),
  marker: z.string(),
  mode: z.enum(["active", "pending", "resilient", "retry", "turbo"]),
});

async function record(marker: string, line: string): Promise<void> {
  "use step";
  appendFileSync(marker, \`\${line}\\n\`);
}

async function gatedEffect(marker: string, gate: string): Promise<void> {
  "use step";
  appendFileSync(marker, "active-entered\\n");
  while (!existsSync(gate)) await wait(20);
  appendFileSync(marker, "active-effect\\n");
}

async function retryLater(marker: string): Promise<void> {
  "use step";
  appendFileSync(marker, "retry-attempt\\n");
  throw new RetryableError("synthetic retry requested", { retryAfter: 60_000 });
}

export async function cancelE2eWorkflow(inputs: WorkflowInputs<typeof cancelE2eInputs>) {
  "use workflow";
  if (inputs.mode === "active") {
    await createRunDirectory();
    await gatedEffect(inputs.marker, inputs.gate);
    await record(inputs.marker, "active-successor");
    return;
  }
  if (inputs.mode === "retry") {
    await retryLater(inputs.marker);
    await record(inputs.marker, "retry-successor");
    return;
  }
  if (inputs.mode === "pending") {
    await sleep(1);
    await record(inputs.marker, "pending-body");
    return;
  }
  if (inputs.mode === "resilient") {
    await record(inputs.marker, "resilient-first-effect");
    return;
  }
  await record(inputs.marker, "turbo-first-effect");
  await record(inputs.marker, "turbo-successor");
}

export default {
  workflow: cancelE2eWorkflow,
  inputs: cancelE2eInputs,
  release: { onSuccess: "release", onFailure: "keep" },
} satisfies WorkflowEntry<typeof cancelE2eInputs>;
`;

export function installCompiledCancellationFixture(factory, ports) {
  writeFileSync(path.join(factory, "workflows", "cancel-e2e.ts"), fixtureSource);
  const config = path.join(factory, "jigs.config.ts");
  const source = readFileSync(config, "utf8")
    .replace(
      /service: \{ port: \d+, dashboardPort: \d+ \}/,
      `service: { port: ${ports.service}, dashboardPort: ${ports.dashboard} }`,
    )
    .replace(
      "workflows: {",
      'workflows: {\n    cancelE2e: () => import("./workflows/cancel-e2e.ts"),',
    );
  writeFileSync(config, source);
}

export async function runCompiledCancellationMatrix({
  adminPostgresUrl,
  cli,
  factory,
  ports,
  scratch,
}) {
  const startedAt = Date.now();
  const database = `jigs_compiled_cancel_${crypto.randomUUID().replaceAll("-", "")}`;
  const testUrl = new URL(adminPostgresUrl);
  testUrl.pathname = `/${database}`;
  const admin = new Pool({ connectionString: adminPostgresUrl, max: 1 });
  let db;
  let serviceRunning = false;
  const fixtureRoot = path.join(scratch, "compiled-cancel");
  const dataHome = path.join(fixtureRoot, "data");
  const bin = path.join(fixtureRoot, "bin");
  const env = runtimeEnv(testUrl.toString(), dataHome, bin, ports);

  mkdirSync(bin, { recursive: true });
  installSystemdFixture(bin);
  writeFileSync(
    path.join(factory, ".env"),
    `WORKFLOW_POSTGRES_URL=${testUrl.toString()}\nWORKFLOW_TARGET_WORLD=@workflow/world-postgres\nWORKFLOW_POSTGRES_WORKER_CONCURRENCY=1\nWORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN=1\n`,
  );

  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    execFileSync(path.join(factory, "node_modules", ".bin", "bootstrap"), [], {
      cwd: factory,
      env,
      stdio: "ignore",
    });
    db = new Pool({ connectionString: testUrl.toString(), max: 2 });

    service("start");
    serviceRunning = true;

    const delayed = await reachScheduledRetry("delayed", fixtureRoot, ports.service, db);
    const exhausted = await reachScheduledRetry("exhausted", fixtureRoot, ports.service, db);
    await exhaustRun(db, exhausted.runId);
    const exhaustedBefore = onlyJob(await jobsFor(db, exhausted.runId), exhausted.runId);
    assert.equal(exhaustedBefore.attempts, exhaustedBefore.maxAttempts);
    assert.equal(exhaustedBefore.lastError, "synthetic exhausted generated delivery");
    console.log("cancellation matrix: retry-scheduled and exhausted deliveries reached");

    cancel(delayed.runId);
    cancel(exhausted.runId);
    await assertCancelled(delayed.runId, ports.service);
    await assertCancelled(exhausted.runId, ports.service);
    console.log("cancellation matrix: retry-scheduled and exhausted runs are terminal-cancelled");

    // The delayed delivery survives a clean process boundary. Waking it after
    // restart drives the generated handler for an already-cancelled run.
    service("stop");
    serviceRunning = false;
    await wakeRun(db, delayed.runId);
    service("start");
    serviceRunning = true;
    await until(
      async () => (await jobsFor(db, delayed.runId)).length === 0,
      "cancelled retry delivery was not acknowledged after restart",
    );
    assert.deepEqual(lines(delayed.marker), ["retry-attempt"]);
    console.log("cancellation matrix: cancelled redelivery acknowledged after restart");

    const activeMarker = path.join(fixtureRoot, "active.markers");
    const activeGate = path.join(fixtureRoot, "active.release");
    const activeLaunch = await launchInlineRun(
      { mode: "active", marker: activeMarker, gate: activeGate },
      ports.service,
      db,
    );
    const activeRunId = activeLaunch.runId;
    await until(
      () => lines(activeMarker).includes("active-entered"),
      "active inline step did not reach its deterministic gate",
    );
    await until(
      async () => (await jobsFor(db, activeRunId)).some((job) => job.lockedAt !== null),
      "active delivery never became locked",
    );

    const pendingMarker = path.join(fixtureRoot, "pending.markers");
    const pendingLaunch = await launchInlineRun(
      { mode: "pending", marker: pendingMarker, gate: "unused" },
      ports.service,
      db,
    );
    const pendingRunId = pendingLaunch.runId;
    await until(async () => {
      const jobs = await jobsFor(db, pendingRunId);
      return jobs.length === 1 && jobs[0].lockedAt === null;
    }, "pending delivery was not held behind the active inline step");

    const turboMarker = path.join(fixtureRoot, "turbo.markers");
    const turboLaunch = await launchInlineRun(
      { mode: "turbo", marker: turboMarker, gate: "unused" },
      ports.service,
      db,
    );
    const turboRunId = turboLaunch.runId;
    await until(async () => {
      const jobs = await jobsFor(db, turboRunId);
      return jobs.length === 1 && jobs[0].lockedAt === null;
    }, "default-turbo delivery was not held behind the active inline step");

    const resilientMarker = path.join(fixtureRoot, "resilient.markers");
    const resilientLaunch = await launchInlineRun(
      { mode: "resilient", marker: resilientMarker, gate: "unused" },
      ports.service,
      db,
    );
    const resilientRunId = resilientLaunch.runId;
    await until(async () => {
      const jobs = await jobsFor(db, resilientRunId);
      return jobs.length === 1 && jobs[0].lockedAt === null;
    }, "resilient first delivery was not held behind the active inline step");
    // start() publishes run_created and the runInput-bearing delivery in
    // parallel. Remove the synthetic run's completed write to deterministically
    // emulate that write being lost while retaining the real generated payload.
    await forgetRunCreation(db, resilientRunId);

    cancel(pendingRunId);
    cancel(turboRunId);
    cancel(activeRunId);
    await assertCancelled(pendingRunId, ports.service);
    await assertCancelled(turboRunId, ports.service);
    const active = await assertCancelled(activeRunId, ports.service);
    assert.equal(active.cleanup.status, "waiting");
    assert.equal(active.resources.length, 1);
    assert.equal(active.resources[0].kind, "run-directory");
    const activeDirectory = fileURLToPath(active.resources[0].url);
    assert.equal(existsSync(activeDirectory), true);
    assert.deepEqual(lines(activeMarker), ["active-entered"]);
    assert.deepEqual(lines(pendingMarker), []);
    assert.deepEqual(lines(turboMarker), []);
    assert.deepEqual(lines(resilientMarker), []);
    console.log(
      "cancellation matrix: active, pending, and default-turbo runs are terminal-cancelled",
    );

    const automatic = JSON.parse(
      runNode(
        `import { reconcileAutomaticRelease } from "@jigs-ai/jigs/automatic-release";
import { getWorld } from "workflow/runtime";
const report = await reconcileAutomaticRelease({ workflows: {} });
console.log(JSON.stringify(report));
await (await getWorld()).close?.();`,
        env,
      ),
    );
    assert.ok(
      automatic.busy >= 1,
      `automatic cleanup did not report active work: ${JSON.stringify(automatic)}`,
    );
    assert.equal(existsSync(activeDirectory), true);
    console.log("cancellation matrix: cleanup and prune fenced while work is active");
    assert.equal((await runtimeRun(activeRunId, ports.service)).cleanup.status, "waiting");

    const activeApply = runCli(
      ["resources", "prune", "--run", activeRunId, "--include-kept", "--apply", "--json"],
      env,
      { allowFailure: true },
    );
    assert.notEqual(activeApply.status, 0);
    assert.match(activeApply.output, /factory service is still running/);
    assert.equal(existsSync(activeDirectory), true);

    appendFileSync(activeGate, "release\n");
    await until(
      () => lines(activeMarker).includes("active-effect"),
      "active step did not finish after its gate opened",
    );
    await until(
      async () => (await jobsFor(db, pendingRunId)).length === 0,
      "cancelled pending delivery was not acknowledged",
    );
    await until(
      async () => (await jobsFor(db, turboRunId)).length === 0,
      "cancelled default-turbo delivery was not acknowledged",
    );
    await until(
      async () => (await jobsFor(db, activeRunId)).length === 0,
      "active delivery did not finish after cancellation",
    );
    await until(
      () => lines(resilientMarker).includes("resilient-first-effect"),
      "runInput delivery did not recreate and execute its missing run",
    );
    await until(
      async () => (await jobsFor(db, resilientRunId)).length === 0,
      "resilient first delivery did not drain after recreating its run",
    );
    await until(
      async () => (await runtimeRun(resilientRunId, ports.service)).status === "completed",
      "recreated resilient run did not reach completed status",
    );

    const [activeStarted, pendingStarted, turboStarted, resilientStarted] = await Promise.all([
      activeLaunch.completion,
      pendingLaunch.completion,
      turboLaunch.completion,
      resilientLaunch.completion,
    ]);
    assertLaunchMatches(activeStarted, activeRunId);
    assertLaunchMatches(pendingStarted, pendingRunId);
    assertLaunchMatches(turboStarted, turboRunId);
    assertLaunchMatches(resilientStarted, resilientRunId);

    assert.deepEqual(lines(activeMarker), ["active-entered", "active-effect"]);
    assert.deepEqual(lines(pendingMarker), []);
    assert.deepEqual(lines(turboMarker), []);
    assert.deepEqual(lines(resilientMarker), ["resilient-first-effect"]);
    assert.equal((await runtimeRun(resilientRunId, ports.service)).status, "completed");
    const activeTimeline = await runtimeTimeline(activeRunId, ports.service);
    assert.equal(
      activeTimeline.steps.filter((step) => step.name.includes("gatedEffect")).length,
      1,
    );
    assert.equal(
      activeTimeline.steps.some((step) => step.name.includes("record")),
      false,
    );

    const reconciled = JSON.parse(
      runNode(
        `import { reconcileAutomaticRelease } from "@jigs-ai/jigs/automatic-release";
import { getWorld } from "workflow/runtime";
const report = await reconcileAutomaticRelease({ workflows: {} });
console.log(JSON.stringify(report));
await (await getWorld()).close?.();`,
        env,
      ),
    );
    assert.ok(
      reconciled.kept >= 1,
      `automatic cleanup did not retain the cancelled resource: ${JSON.stringify(reconciled)}`,
    );
    await until(
      async () => (await runtimeRun(activeRunId, ports.service)).cleanup.status === "kept",
      "automatic cleanup did not record the keep decision",
    );
    assert.equal(existsSync(activeDirectory), true);

    await new Promise((resolve) => setTimeout(resolve, DRAIN_MS));
    assert.deepEqual(lines(delayed.marker), ["retry-attempt"]);
    assert.deepEqual(lines(exhausted.marker), ["retry-attempt"]);
    assert.deepEqual(lines(activeMarker), ["active-entered", "active-effect"]);
    assert.deepEqual(lines(pendingMarker), []);
    assert.deepEqual(lines(turboMarker), []);
    assert.deepEqual(lines(resilientMarker), ["resilient-first-effect"]);
    assert.equal((await jobsFor(db, delayed.runId)).length, 0);
    assert.equal((await jobsFor(db, pendingRunId)).length, 0);
    assert.equal((await jobsFor(db, turboRunId)).length, 0);
    assert.equal((await jobsFor(db, activeRunId)).length, 0);
    assert.equal((await jobsFor(db, resilientRunId)).length, 0);
    const exhaustedAfterDrain = onlyJob(await jobsFor(db, exhausted.runId), exhausted.runId);
    assert.deepEqual(exhaustedAfterDrain, exhaustedBefore);

    for (const runId of [delayed.runId, exhausted.runId, pendingRunId, turboRunId, activeRunId]) {
      await assertCancelled(runId, ports.service);
    }
    const delayedTimeline = await runtimeTimeline(delayed.runId, ports.service);
    const exhaustedTimeline = await runtimeTimeline(exhausted.runId, ports.service);
    for (const timeline of [delayedTimeline, exhaustedTimeline]) {
      assert.equal(timeline.steps.length, 1);
      assert.match(timeline.steps[0].name, /retryLater/);
      assert.equal(timeline.steps[0].status, "pending");
      assert.equal(timeline.steps[0].attempt, 1);
      assert.equal(timeline.steps[0].error, null);
      assert.equal(
        timeline.steps.some((step) => step.name.includes("record")),
        false,
      );
    }
    assert.equal(exhaustedTimeline.deadJobs.length, 1);
    assert.equal(exhaustedTimeline.deadJobs[0].attempts, exhaustedBefore.maxAttempts);

    service("stop");
    serviceRunning = false;
    assertNoRecordedProcess(dataHome);

    const beforePrune = await historySnapshot(db, activeRunId);
    const listed = JSON.parse(
      runCli(["resources", "list", "--run", activeRunId, "--json"], env).output,
    );
    assertResourceReport(listed, activeRunId, false, undefined);
    const preview = JSON.parse(
      runCli(["resources", "prune", "--run", activeRunId, "--json"], env).output,
    );
    assertResourceReport(preview, activeRunId, false, undefined);
    const included = JSON.parse(
      runCli(["resources", "prune", "--run", activeRunId, "--include-kept", "--json"], env).output,
    );
    assertResourceReport(included, activeRunId, true, undefined);
    const applied = JSON.parse(
      runCli(
        ["resources", "prune", "--run", activeRunId, "--include-kept", "--apply", "--json"],
        env,
      ).output,
    );
    assertResourceReport(applied, activeRunId, true, "remove");
    assert.equal(existsSync(activeDirectory), false);
    assert.deepEqual(await historySnapshot(db, activeRunId), beforePrune);

    const elapsedMs = Date.now() - startedAt;
    console.log(
      `compiled cancellation matrix passed in ${elapsedMs}ms: pending, retry-scheduled, exhausted, active inline, default-turbo race, resilient first delivery, restart/redelivery, cleanup fencing, and offline kept-resource prune`,
    );
    return { elapsedMs };
  } finally {
    if (serviceRunning) {
      try {
        service("stop");
      } catch {
        killRecordedProcesses(dataHome);
      }
    }
    killRecordedProcesses(dataHome);
    await db?.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }

  function service(action) {
    const result = runCli(["service", action], env, {
      allowFailure: true,
      timeout: SERVICE_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      throw new Error(`jigs service ${action} failed\n${result.output}\n${serviceLogs(dataHome)}`);
    }
  }

  function cancel(runId) {
    const result = runCli(
      ["cancel", runId, "--force", "--service-url", `http://127.0.0.1:${ports.service}`],
      env,
    );
    assert.match(result.output, new RegExp(`cancelled ${runId}`));
  }

  function runCli(args, commandEnv, options = {}) {
    try {
      return {
        status: 0,
        output: execFileSync(process.execPath, [cli, ...args], {
          cwd: factory,
          env: commandEnv,
          encoding: "utf8",
          timeout: options.timeout ?? TIMEOUT_MS,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      };
    } catch (error) {
      const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`;
      if (options.allowFailure) return { status: error.status ?? 1, output };
      throw new Error(`jigs ${args.join(" ")} failed\n${output}`, { cause: error });
    }
  }

  function runNode(source, commandEnv) {
    return execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: factory,
      env: commandEnv,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
    });
  }
}

async function reachScheduledRetry(name, fixtureRoot, port, db) {
  const marker = path.join(fixtureRoot, `${name}.markers`);
  const runId = await startRun({ mode: "retry", marker, gate: "unused" }, port);
  await until(
    () => lines(marker).length === 1,
    `${name} retry step did not execute exactly once before scheduling`,
  );
  await until(async () => {
    const jobs = await jobsFor(db, runId);
    return (
      jobs.length === 1 &&
      jobs[0].lockedAt === null &&
      new Date(jobs[0].runAt).getTime() > Date.now() + 5_000
    );
  }, `${name} step never produced a future retry delivery`);
  return { runId, marker };
}

async function startRun(inputs, port, timeout = 5_000) {
  const response = await fetch(`http://127.0.0.1:${port}/api/workflows/cancelE2e/runs`, {
    method: "POST",
    headers: { connection: "close", "content-type": "application/json" },
    body: JSON.stringify({ inputs }),
    signal: AbortSignal.timeout(timeout),
  });
  if (response.status !== 201) {
    throw new Error(`workflow start returned ${response.status}: ${await response.text()}`);
  }
  return (await response.json()).runId;
}

async function launchInlineRun(inputs, port, db) {
  const existing = new Set(await runIds(db));
  const completion = startRun(inputs, port, TIMEOUT_MS).then(
    (runId) => ({ runId }),
    (error) => ({ error }),
  );
  let runId;
  await until(async () => {
    const created = (await runIds(db)).filter((candidate) => !existing.has(candidate));
    assert.ok(created.length <= 1, `launch persisted multiple runs: ${JSON.stringify(created)}`);
    runId = created[0];
    return runId !== undefined;
  }, "inline launch did not persist a run");
  return {
    runId,
    completion,
  };
}

function assertLaunchMatches(result, runId) {
  if ("runId" in result) {
    assert.equal(result.runId, runId);
    return;
  }
  assert.match(
    String(result.error),
    /fetch failed|TimeoutError/,
    "an optimistic inline trigger may outlive its client while its persisted run continues",
  );
}

async function runtimeRun(runId, port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}`, {
    headers: { connection: "close" },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 200) {
    throw new Error(`run lookup returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function runtimeTimeline(runId, port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/steps`, {
    headers: { connection: "close" },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 200) {
    throw new Error(`timeline lookup returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function assertCancelled(runId, port) {
  const run = await runtimeRun(runId, port);
  assert.equal(run.status, "cancelled", `run ${runId} is ${run.status}`);
  return run;
}

async function jobsFor(db, runId) {
  return (
    await db.query(
      `SELECT body.id::text, body.attempts, body.max_attempts AS "maxAttempts",
              body.locked_at AS "lockedAt", body.run_at AS "runAt",
              body.last_error AS "lastError"
       FROM graphile_worker._private_jobs AS body
       WHERE convert_from(decode(body.payload->>'data', 'base64'), 'LATIN1') LIKE $1
       ORDER BY body.created_at`,
      [`%${runId}%`],
    )
  ).rows.map((row) => ({
    ...row,
    lockedAt: row.lockedAt?.toISOString() ?? null,
    runAt: row.runAt.toISOString(),
  }));
}

async function runIds(db) {
  return (await db.query(`SELECT id FROM workflow.workflow_runs ORDER BY created_at`)).rows.map(
    (row) => row.id,
  );
}

function onlyJob(jobs, runId) {
  assert.equal(jobs.length, 1, `expected one queue job for ${runId}: ${JSON.stringify(jobs)}`);
  return jobs[0];
}

async function exhaustRun(db, runId) {
  const result = await db.query(
    `UPDATE graphile_worker._private_jobs
     SET attempts = max_attempts, last_error = 'synthetic exhausted generated delivery'
     WHERE convert_from(decode(payload->>'data', 'base64'), 'LATIN1') LIKE $1`,
    [`%${runId}%`],
  );
  assert.equal(result.rowCount, 1, `could not exhaust the generated delivery for ${runId}`);
}

async function wakeRun(db, runId) {
  const result = await db.query(
    `UPDATE graphile_worker._private_jobs
     SET run_at = now()
     WHERE attempts < max_attempts
       AND convert_from(decode(payload->>'data', 'base64'), 'LATIN1') LIKE $1`,
    [`%${runId}%`],
  );
  assert.equal(result.rowCount, 1, `could not wake the generated delivery for ${runId}`);
}

async function forgetRunCreation(db, runId) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const events = await client.query(`DELETE FROM workflow.workflow_events WHERE run_id = $1`, [
      runId,
    ]);
    const slots = await client.query(
      `DELETE FROM workflow.workflow_event_slots WHERE run_id = $1`,
      [runId],
    );
    const runs = await client.query(`DELETE FROM workflow.workflow_runs WHERE id = $1`, [runId]);
    assert.equal(events.rowCount, 1, `expected one run_created event for ${runId}`);
    assert.equal(slots.rowCount, 1, `expected one event-slot marker for ${runId}`);
    assert.equal(runs.rowCount, 1, `expected one run projection for ${runId}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function historySnapshot(db, runId) {
  const [runs, events, steps] = await Promise.all([
    db.query(`SELECT id, status, name, attributes FROM workflow.workflow_runs WHERE id = $1`, [
      runId,
    ]),
    db.query(
      `SELECT id, type, correlation_id, payload, payload_cbor, spec_version
       FROM workflow.workflow_events WHERE run_id = $1 ORDER BY id`,
      [runId],
    ),
    db.query(
      `SELECT step_id, step_name, status, attempt, started_at, completed_at, retry_after
       FROM workflow.workflow_steps WHERE run_id = $1 ORDER BY created_at`,
      [runId],
    ),
  ]);
  return JSON.parse(JSON.stringify({ runs: runs.rows, events: events.rows, steps: steps.rows }));
}

function assertResourceReport(report, runId, eligible, action) {
  assert.equal(report.complete, true);
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].runId, runId);
  assert.equal(report.entries[0].kind, "run-directory");
  assert.equal(report.entries[0].kept, true);
  assert.equal(report.entries[0].eligible, eligible);
  if (action !== undefined) assert.equal(report.entries[0].action, action);
}

function runtimeEnv(postgresUrl, dataHome, bin, ports) {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    XDG_DATA_HOME: dataHome,
    PORT: String(ports.service),
    JIGS_DASHBOARD_PORT: String(ports.dashboard),
    WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${ports.service}`,
    WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN: "1",
    WORKFLOW_POSTGRES_URL: postgresUrl,
    WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "1",
    WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
  };
}

function installSystemdFixture(bin) {
  const systemdRun = path.join(bin, "systemd-run");
  writeFileSync(
    systemdRun,
    `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
shift 3
exec "$@"
`,
  );
  chmodSync(systemdRun, 0o755);
  const systemctl = path.join(bin, "systemctl");
  writeFileSync(
    systemctl,
    `#!/bin/sh
case "$*" in
  *show-environment*) exit 0 ;;
  *is-active*) echo inactive; exit 0 ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(systemctl, 0o755);
}

function lines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

function pidFiles(dataHome) {
  const services = path.join(dataHome, "jigs", "services");
  if (!existsSync(services)) return [];
  return readdirSync(services)
    .filter((name) => name.endsWith(".pid"))
    .map((name) => path.join(services, name));
}

function assertNoRecordedProcess(dataHome) {
  assert.deepEqual(pidFiles(dataHome), [], "service stop left a pidfile behind");
}

function killRecordedProcesses(dataHome) {
  for (const file of pidFiles(dataHome)) {
    const pid = Number(readFileSync(file, "utf8").trim());
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    rmSync(file, { force: true });
  }
}

function serviceLogs(dataHome) {
  const services = path.join(dataHome, "jigs", "services");
  if (!existsSync(services)) return "no service logs";
  return readdirSync(services)
    .filter((name) => name.endsWith(".log"))
    .map((name) => readFileSync(path.join(services, name), "utf8"))
    .join("\n");
}

async function until(check, message, timeout = TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
