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
const PI_STOP_BUDGET_MS = 5_000;

// A stand-in for pi: records its launch and pid, starts a child that ignores
// SIGTERM, then hangs, or waits for a release file and answers like Pi does.
const controlledPi = `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const { mode, dir } = JSON.parse(args.at(-1));
fs.appendFileSync(path.join(dir, "launches"), "launch\\n");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(path.join(dir, "pids"), process.pid + " " + child.pid);
const sessionId = args[args.indexOf("--session-id") + 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
setInterval(() => {
  if (mode !== "finish" || !fs.existsSync(path.join(dir, "release"))) return;
  emit({ type: "session", id: sessionId });
  emit({ type: "agent_start" });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "finished" }], stopReason: "stop" } });
  emit({ type: "agent_end", messages: [], willRetry: false });
  emit({ type: "agent_settled" });
  process.exit(0);
}, 50);
`;

// A stand-in for the Codex app server: speaks enough JSON-RPC for one turn,
// whose prompt carries its mode and directory. Once the turn starts it records
// its launch, its supervisor's pid, its own and a SIGTERM-ignoring child's,
// then hangs or waits for a release file and finishes the turn.
const controlledCodex = `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { userAgent: "codex_cli_rs/0.200.0", capabilities: {} } });
  if (method === "thread/start") send({ id, result: { thread: { id: "thread-e2e" } } });
  if (method !== "turn/start") return;
  const prompt = params.input.map((item) => item.text ?? "").join("");
  const { mode, dir } = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.lastIndexOf("}") + 1));
  fs.appendFileSync(path.join(dir, "launches"), "launch\\n");
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
  send({ id, result: { turn: { id: "turn-e2e", items: [], status: "inProgress" } } });
  child.stdout.once("data", () => fs.writeFileSync(path.join(dir, "pids"), [process.ppid, process.pid, child.pid].join(" ")));
  const timer = setInterval(() => {
    if (mode !== "finish" || !fs.existsSync(path.join(dir, "release"))) return;
    clearInterval(timer);
    const turn = { threadId: "thread-e2e", turnId: "turn-e2e" };
    send({ method: "item/agentMessage/delta", params: { ...turn, itemId: "msg-e2e", delta: "finished" } });
    send({ method: "turn/completed", params: { threadId: "thread-e2e", turn: { id: "turn-e2e", items: [], status: "completed" } } });
  }, 50);
});
`;

function writeControlledCodex(root) {
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, "codex");
  writeFileSync(executable, `#!${process.execPath}\n${controlledCodex}`);
  chmodSync(executable, 0o755);
  // The Codex driver links the login into each invocation home; the stand-in never reads it.
  const home = path.join(root, "home");
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(path.join(home, ".codex", "auth.json"), "{}");
  return { bin, home };
}

function writeControlledPi(root) {
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, "pi");
  writeFileSync(executable, `#!${process.execPath}\n${controlledPi}`);
  chmodSync(executable, 0o755);
  return bin;
}

// A stand-in for Claude Code: speaks enough of its stream-json protocol for
// the provider, reads its behaviour from the prompt, records its launch and
// pid, starts a child that ignores SIGTERM, then hangs, or waits for a release
// file and answers.
const controlledClaude = `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    return;
  }
  if (message.type !== "user") return;
  const content = message.message.content;
  const text = typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
  const { mode, dir } = JSON.parse(text.slice(text.indexOf("{")));
  fs.appendFileSync(path.join(dir, "launches"), "launch\\n");
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "pids"), process.pid + " " + child.pid);
  send({ type: "system", subtype: "init", session_id: "e2e-session", cwd: process.cwd(), tools: [], mcp_servers: [] });
  const timer = setInterval(() => {
    if (mode !== "finish" || !fs.existsSync(path.join(dir, "release"))) return;
    clearInterval(timer);
    send({ type: "assistant", session_id: "e2e-session", message: { role: "assistant", content: [{ type: "text", text: "finished" }] } });
    send({ type: "result", subtype: "success", is_error: false, result: "finished", session_id: "e2e-session", num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
  }, 50);
});
`;

function writeControlledClaude(root) {
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, "claude");
  writeFileSync(executable, `#!${process.execPath}\n${controlledClaude}`);
  chmodSync(executable, 0o755);
  return bin;
}

async function agentPids(dir) {
  const file = path.join(dir, "pids");
  await until(() => existsSync(file), `controlled agent never started in ${dir}`);
  return readFileSync(file, "utf8").trim().split(" ").map(Number);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

const fixtureSource = `import { appendFileSync, existsSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { defineWorkflow, harnesses, models, type WorkflowInputs } from "@jigs-ai/jigs";
import { runAgent } from "#jigs/routines";
import { createRunDirectory } from "#jigs/steps";
import { FatalError, getWorkflowMetadata, RetryableError, sleep } from "workflow";
import { getWorld } from "workflow/runtime";
import { z } from "zod";

export const cancelE2eInputs = z.object({
  gate: z.string(),
  marker: z.string(),
  mode: z.enum([
    "active",
    "claude",
    "codex",
    "fatal",
    "observe",
    "ordinary",
    "pending",
    "pi",
    "resilient",
    "retry",
    "turbo",
  ]),
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

async function gatedThrow(marker: string, gate: string, fatal: boolean): Promise<void> {
  "use step";
  appendFileSync(marker, "throw-entered\\n");
  while (!existsSync(gate)) await wait(20);
  appendFileSync(marker, "throw-raised\\n");
  if (fatal) throw new FatalError("synthetic step error after cancellation");
  throw new Error("synthetic step error after cancellation");
}

async function observeRun(marker: string, label: string): Promise<void> {
  "use step";
  const { workflowRunId } = getWorkflowMetadata();
  let seen: string;
  try {
    seen = (await (await getWorld()).runs.get(workflowRunId, { resolveData: "none" })).status;
  } catch (error) {
    seen = \`missing:\${error instanceof Error ? error.name : String(error)}\`;
  }
  appendFileSync(marker, \`\${label} run=\${seen}\\n\`);
  // What an agent step does when its first status read cannot find the run.
  if (seen.startsWith("missing:")) throw new Error("run not visible yet");
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
  if (inputs.mode === "ordinary" || inputs.mode === "fatal") {
    await createRunDirectory();
    await gatedThrow(inputs.marker, inputs.gate, inputs.mode === "fatal");
    await record(inputs.marker, "throw-successor");
    return;
  }
  if (inputs.mode === "pi") {
    const cwd = await createRunDirectory();
    // The controlled pi on the service's PATH reads its behaviour from the prompt.
    await runAgent({ harness: harnesses.pi(models.openrouter("e2e/fake")), cwd, prompt: inputs.marker });
    await record(inputs.gate, "pi-successor");
    return;
  }
  if (inputs.mode === "claude") {
    const cwd = await createRunDirectory();
    // The controlled claude on the service's PATH reads its behaviour from the prompt.
    await runAgent({ harness: harnesses.claude({ model: "sonnet" }), cwd, prompt: inputs.marker });
    await record(inputs.gate, "claude-successor");
    return;
  }
  if (inputs.mode === "codex") {
    const cwd = await createRunDirectory();
    await runAgent({ harness: harnesses.codex({ model: "e2e/fake" }), cwd, prompt: inputs.marker });
    await record(inputs.gate, "codex-successor");
    return;
  }
  if (inputs.mode === "observe") {
    await observeRun(inputs.marker, "observe-first-step");
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
    await observeRun(inputs.marker, "resilient-first-effect");
    return;
  }
  await record(inputs.marker, "turbo-first-effect");
  await record(inputs.marker, "turbo-successor");
}

export default defineWorkflow({
  inputs: cancelE2eInputs,
  release: { onSuccess: "release", onFailure: "keep" },
  workflow: cancelE2eWorkflow,
});
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
  const env = runtimeEnv(testUrl.toString(), dataHome, ports);
  let serviceEnv = env;

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
    assert.equal(active.resources.length, 1);
    assert.equal(active.resources[0].kind, "run-directory");
    assert.equal(active.resources[0].state, "live");
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
    assert.equal((await runtimeRun(activeRunId, ports.service)).resources[0].state, "live");

    const activeApply = runCli(
      ["resources", "prune", "--run", activeRunId, "--apply", "--json"],
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
      () => lines(resilientMarker).some((line) => line.startsWith("resilient-first-effect")),
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
    const resilientSeen = lines(resilientMarker);
    assert.match(resilientSeen.at(-1), /^resilient-first-effect run=(pending|running)$/);
    for (const line of resilientSeen.slice(0, -1)) assert.match(line, /run=missing:/);
    console.log(
      `cancellation matrix: resilient first step observed ${resilientSeen.map((line) => line.split(" ")[1]).join(", ")}; an ordinary error retried it once the run existed`,
    );
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
      async () => (await runtimeRun(activeRunId, ports.service)).resources[0].state === "kept",
      "automatic cleanup did not record the keep decision",
    );
    assert.equal(existsSync(activeDirectory), true);

    await new Promise((resolve) => setTimeout(resolve, DRAIN_MS));
    assert.deepEqual(lines(delayed.marker), ["retry-attempt"]);
    assert.deepEqual(lines(exhausted.marker), ["retry-attempt"]);
    assert.deepEqual(lines(activeMarker), ["active-entered", "active-effect"]);
    assert.deepEqual(lines(pendingMarker), []);
    assert.deepEqual(lines(turboMarker), []);
    assert.deepEqual(lines(resilientMarker), resilientSeen);
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

    await proveStepErrorAfterCancel("ordinary");
    await proveStepErrorAfterCancel("fatal");
    await proveFirstStepVisibility();

    service("stop");
    serviceRunning = false;
    assertNoRecordedProcess(dataHome);

    const beforePrune = await historySnapshot(db, activeRunId);
    const listed = JSON.parse(
      runCli(["resources", "list", "--run", activeRunId, "--json"], env).output,
    );
    assertResourceReport(listed, activeRunId, true, undefined);
    assert.match(listed.entries[0].decision, /overrides the kept decision/);
    const preview = JSON.parse(
      runCli(["resources", "prune", "--run", activeRunId, "--json"], env).output,
    );
    assertResourceReport(preview, activeRunId, true, undefined);
    const applied = JSON.parse(
      runCli(["resources", "prune", "--run", activeRunId, "--apply", "--json"], env).output,
    );
    assertResourceReport(applied, activeRunId, true, "remove");
    assert.equal(existsSync(activeDirectory), false);
    assert.deepEqual(await historySnapshot(db, activeRunId), beforePrune);

    await provePiCancellation();
    await proveClaudeCancellation();
    await proveCodexCancellation();

    const elapsedMs = Date.now() - startedAt;
    console.log(
      `compiled cancellation matrix passed in ${elapsedMs}ms: pending, retry-scheduled, exhausted, active inline, default-turbo race, resilient first delivery, restart/redelivery, cleanup fencing, step errors after cancel, first-step run visibility, Pi agent stop, Claude Code agent stop, Codex agent stop, and offline kept-resource prune`,
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

  // What the SDK records when the executing step throws after its run was
  // cancelled. The agent step's cancellation error classification rests on it.
  async function proveStepErrorAfterCancel(mode) {
    const marker = path.join(fixtureRoot, `${mode}.markers`);
    const gate = path.join(fixtureRoot, `${mode}.release`);
    const launch = await launchInlineRun({ mode, marker, gate }, ports.service, db);
    await until(
      () => lines(marker).includes("throw-entered"),
      `${mode} step did not reach its gate`,
    );
    cancel(launch.runId);
    await assertCancelled(launch.runId, ports.service);
    appendFileSync(gate, "release\n");
    await until(
      async () => (await jobsFor(db, launch.runId)).length === 0,
      `${mode} deliveries did not drain after the step threw`,
    );
    await new Promise((resolve) => setTimeout(resolve, DRAIN_MS * 2));
    assert.equal((await jobsFor(db, launch.runId)).length, 0);
    assert.deepEqual(lines(marker), ["throw-entered", "throw-raised"]);
    await assertCancelled(launch.runId, ports.service);
    const timeline = await runtimeTimeline(launch.runId, ports.service);
    const thrown = timeline.steps.filter((step) => step.name.includes("gatedThrow"));
    assert.equal(thrown.length, 1);
    assert.equal(
      timeline.steps.some((step) => step.name.includes("record")),
      false,
    );
    reconcile();
    const resource = (await runtimeRun(launch.runId, ports.service)).resources[0];
    if (mode === "fatal") {
      assert.equal(thrown[0].status, "failed");
      assert.equal(resource.state, "kept", "a failed step leaves release free to decide");
    } else {
      assert.equal(thrown[0].status, "pending", "an ordinary error schedules a retry");
      assert.equal(resource.state, "live", "a pending retry keeps release fenced as busy");
    }
    console.log(
      `cancellation matrix: ${mode} error after cancel leaves the step ${thrown[0].status} (attempt ${thrown[0].attempt}), no second attempt, resource ${resource.state}`,
    );
  }

  // Whether an agent step's status read can find its own run from the first
  // step of a default-turbo start.
  async function proveFirstStepVisibility() {
    const seen = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const marker = path.join(fixtureRoot, `observe-${attempt}.markers`);
      const runId = await startRun({ mode: "observe", marker, gate: "unused" }, ports.service);
      await until(
        async () => (await runtimeRun(runId, ports.service)).status === "completed",
        "observe run did not complete",
      );
      assert.equal(lines(marker).length, 1);
      seen.push(lines(marker)[0].split(" ")[1]);
    }
    console.log(`cancellation matrix: default-turbo first steps observed ${seen.join(", ")}`);
  }

  function reconcile() {
    return JSON.parse(
      runNode(
        `import { reconcileAutomaticRelease } from "@jigs-ai/jigs/automatic-release";
import { getWorld } from "workflow/runtime";
const report = await reconcileAutomaticRelease({ workflows: {} });
console.log(JSON.stringify(report));
await (await getWorld()).close?.();`,
        env,
      ),
    );
  }

  // CLI cancel -> service -> World -> generated step -> real Pi driver -> a
  // controlled pi and its child, beside a second Pi run that must not notice.
  async function provePiCancellation() {
    const piRoot = path.join(fixtureRoot, "pi");
    const bin = writeControlledPi(piRoot);
    const cancelledDir = path.join(piRoot, "cancelled");
    const survivorDir = path.join(piRoot, "survivor");
    mkdirSync(cancelledDir, { recursive: true });
    mkdirSync(survivorDir, { recursive: true });
    // Two workers, so the survivor's step runs beside the cancelled one.
    writeFileSync(
      path.join(factory, ".env"),
      `WORKFLOW_POSTGRES_URL=${testUrl.toString()}\nWORKFLOW_TARGET_WORLD=@workflow/world-postgres\nWORKFLOW_POSTGRES_WORKER_CONCURRENCY=2\nWORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN=1\n`,
    );
    serviceEnv = {
      ...env,
      PATH: `${bin}${path.delimiter}${env.PATH}`,
      OPENROUTER_API_KEY: "e2e-never-sent",
      WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "2",
    };
    service("start");
    serviceRunning = true;

    const cancelled = await launchInlineRun(
      {
        mode: "pi",
        marker: JSON.stringify({ mode: "hang", dir: cancelledDir }),
        gate: path.join(cancelledDir, "successor"),
      },
      ports.service,
      db,
    );
    const cancelledPids = await agentPids(cancelledDir);
    const survivor = await launchInlineRun(
      {
        mode: "pi",
        marker: JSON.stringify({ mode: "finish", dir: survivorDir }),
        gate: path.join(survivorDir, "successor"),
      },
      ports.service,
      db,
    );
    const survivorPids = await agentPids(survivorDir);

    cancel(cancelled.runId);
    const cancelledAt = Date.now();
    await until(
      () => !cancelledPids.some(alive),
      "the cancelled run's pi or its child outlived the 5s budget",
      PI_STOP_BUDGET_MS,
    );
    const stopMs = Date.now() - cancelledAt;
    cancel(cancelled.runId);
    await assertCancelled(cancelled.runId, ports.service);
    assert.ok(survivorPids.every(alive), "stopping one run's pi reached another run's pi");
    await until(
      async () => (await jobsFor(db, cancelled.runId)).length === 0,
      "the cancelled pi run's deliveries did not drain",
    );

    appendFileSync(path.join(survivorDir, "release"), "release\n");
    await until(
      async () => (await runtimeRun(survivor.runId, ports.service)).status === "completed",
      "the other pi run did not complete after the cancellation",
    );
    assert.ok(!survivorPids.some(alive), "the finished pi's child outlived its step");
    assert.deepEqual(lines(path.join(survivorDir, "successor")), ["pi-successor"]);

    await new Promise((resolve) => setTimeout(resolve, DRAIN_MS * 2));
    assert.deepEqual(lines(path.join(cancelledDir, "launches")), ["launch"], "pi was relaunched");
    assert.deepEqual(lines(path.join(cancelledDir, "successor")), []);
    assert.equal((await jobsFor(db, cancelled.runId)).length, 0);
    await assertCancelled(cancelled.runId, ports.service);
    const timeline = await runtimeTimeline(cancelled.runId, ports.service);
    const agentSteps = timeline.steps.filter((step) => /agent/i.test(step.name));
    assert.equal(agentSteps.length, 1, JSON.stringify(timeline.steps));
    assert.equal(agentSteps[0].status, "failed");
    assert.equal(agentSteps[0].attempt, 1);
    assert.match(
      serviceLogs(dataHome),
      new RegExp(
        `RunCancelledError: run ${cancelled.runId} was cancelled, so jigs stopped its agent`,
      ),
    );
    reconcile();
    assert.equal(
      (await runtimeRun(cancelled.runId, ports.service)).resources.find(
        (resource) => resource.kind === "run-directory",
      )?.state,
      "kept",
      "the failed agent step left release free to decide",
    );
    await Promise.all([cancelled.completion, survivor.completion]);

    service("stop");
    serviceRunning = false;
    serviceEnv = env;
    console.log(
      `cancellation matrix: CLI cancel stopped a real Pi driver's pi and child in ${stopMs}ms; the agent step failed once with no retry or successor, a repeated cancel was safe, and another Pi run finished`,
    );
  }

  // CLI cancel -> service -> World -> generated step -> real Claude driver and
  // provider -> a controlled claude and its child, beside a second Claude run
  // that must not notice and whose leftover child is stopped when it finishes.
  async function proveClaudeCancellation() {
    const claudeRoot = path.join(fixtureRoot, "claude");
    const bin = writeControlledClaude(claudeRoot);
    const cancelledDir = path.join(claudeRoot, "cancelled");
    const survivorDir = path.join(claudeRoot, "survivor");
    mkdirSync(cancelledDir, { recursive: true });
    mkdirSync(survivorDir, { recursive: true });
    serviceEnv = {
      ...env,
      PATH: `${bin}${path.delimiter}${env.PATH}`,
      WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "2",
    };
    service("start");
    serviceRunning = true;

    const cancelled = await launchInlineRun(
      {
        mode: "claude",
        marker: JSON.stringify({ mode: "hang", dir: cancelledDir }),
        gate: path.join(cancelledDir, "successor"),
      },
      ports.service,
      db,
    );
    const cancelledPids = await agentPids(cancelledDir);
    const survivor = await launchInlineRun(
      {
        mode: "claude",
        marker: JSON.stringify({ mode: "finish", dir: survivorDir }),
        gate: path.join(survivorDir, "successor"),
      },
      ports.service,
      db,
    );
    const survivorPids = await agentPids(survivorDir);

    cancel(cancelled.runId);
    const cancelledAt = Date.now();
    await until(
      () => !cancelledPids.some(alive),
      "the cancelled run's claude or its child outlived the 5s budget",
      PI_STOP_BUDGET_MS,
    );
    const stopMs = Date.now() - cancelledAt;
    await assertCancelled(cancelled.runId, ports.service);
    assert.ok(survivorPids.every(alive), "stopping one run's claude reached another run's claude");
    await until(
      async () => (await jobsFor(db, cancelled.runId)).length === 0,
      "the cancelled claude run's deliveries did not drain",
    );

    appendFileSync(path.join(survivorDir, "release"), "release\n");
    await until(
      async () => (await runtimeRun(survivor.runId, ports.service)).status === "completed",
      "the other claude run did not complete after the cancellation",
    );
    assert.ok(!survivorPids.some(alive), "the finished claude's child outlived its step");
    assert.deepEqual(lines(path.join(survivorDir, "successor")), ["claude-successor"]);

    await new Promise((resolve) => setTimeout(resolve, DRAIN_MS * 2));
    assert.deepEqual(
      lines(path.join(cancelledDir, "launches")),
      ["launch"],
      "claude was relaunched",
    );
    assert.deepEqual(lines(path.join(cancelledDir, "successor")), []);
    const timeline = await runtimeTimeline(cancelled.runId, ports.service);
    const agentSteps = timeline.steps.filter((step) => /agent/i.test(step.name));
    assert.equal(agentSteps.length, 1, JSON.stringify(timeline.steps));
    assert.equal(agentSteps[0].status, "failed");
    assert.equal(agentSteps[0].attempt, 1);
    assert.match(
      serviceLogs(dataHome),
      new RegExp(
        `RunCancelledError: run ${cancelled.runId} was cancelled, so jigs stopped its agent`,
      ),
    );
    await Promise.all([cancelled.completion, survivor.completion]);

    service("stop");
    serviceRunning = false;
    serviceEnv = env;
    console.log(
      `cancellation matrix: CLI cancel stopped a real Claude driver's claude and child in ${stopMs}ms; the agent step failed once with no retry or successor, and another Claude run finished without leaving its child behind`,
    );
  }

  // CLI cancel -> service -> World -> generated step -> real Codex driver and
  // provider -> the launcher, a controlled app server and its child, beside a
  // second Codex run that must not notice.
  async function proveCodexCancellation() {
    const codexRoot = path.join(fixtureRoot, "codex");
    const { bin, home } = writeControlledCodex(codexRoot);
    const cancelledDir = path.join(codexRoot, "cancelled");
    const survivorDir = path.join(codexRoot, "survivor");
    mkdirSync(cancelledDir, { recursive: true });
    mkdirSync(survivorDir, { recursive: true });
    writeFileSync(
      path.join(factory, ".env"),
      `WORKFLOW_POSTGRES_URL=${testUrl.toString()}\nWORKFLOW_TARGET_WORLD=@workflow/world-postgres\nWORKFLOW_POSTGRES_WORKER_CONCURRENCY=2\nWORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN=1\n`,
    );
    serviceEnv = {
      ...env,
      HOME: home,
      PATH: `${bin}${path.delimiter}${env.PATH}`,
      WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "2",
    };
    service("start");
    serviceRunning = true;

    const cancelled = await launchInlineRun(
      {
        mode: "codex",
        marker: JSON.stringify({ mode: "hang", dir: cancelledDir }),
        gate: path.join(cancelledDir, "successor"),
      },
      ports.service,
      db,
    );
    const cancelledPids = await agentPids(cancelledDir);
    const survivor = await launchInlineRun(
      {
        mode: "codex",
        marker: JSON.stringify({ mode: "finish", dir: survivorDir }),
        gate: path.join(survivorDir, "successor"),
      },
      ports.service,
      db,
    );
    const survivorPids = await agentPids(survivorDir);

    cancel(cancelled.runId);
    const cancelledAt = Date.now();
    await until(
      () => !cancelledPids.some(alive),
      "the cancelled run's Codex launcher, app server or child outlived the 5s budget",
      PI_STOP_BUDGET_MS,
    );
    const stopMs = Date.now() - cancelledAt;
    cancel(cancelled.runId);
    await assertCancelled(cancelled.runId, ports.service);
    assert.ok(survivorPids.every(alive), "stopping one run's Codex reached another run's Codex");
    await until(
      async () => (await jobsFor(db, cancelled.runId)).length === 0,
      "the cancelled Codex run's deliveries did not drain",
    );

    appendFileSync(path.join(survivorDir, "release"), "release\n");
    await until(
      async () => (await runtimeRun(survivor.runId, ports.service)).status === "completed",
      "the other Codex run did not complete after the cancellation",
    );
    // The supervisor stops the group after the step closes the provider.
    await until(
      () => !survivorPids.some(alive),
      "the finished Codex launcher, app server or child outlived its step",
      PI_STOP_BUDGET_MS,
    );
    assert.deepEqual(lines(path.join(survivorDir, "successor")), ["codex-successor"]);

    await new Promise((resolve) => setTimeout(resolve, DRAIN_MS * 2));
    assert.deepEqual(
      lines(path.join(cancelledDir, "launches")),
      ["launch"],
      "Codex was relaunched",
    );
    assert.deepEqual(lines(path.join(cancelledDir, "successor")), []);
    const timeline = await runtimeTimeline(cancelled.runId, ports.service);
    const agentSteps = timeline.steps.filter((step) => /agent/i.test(step.name));
    assert.equal(agentSteps.length, 1, JSON.stringify(timeline.steps));
    assert.equal(agentSteps[0].status, "failed");
    assert.equal(agentSteps[0].attempt, 1);
    assert.match(
      serviceLogs(dataHome),
      new RegExp(
        `RunCancelledError: run ${cancelled.runId} was cancelled, so jigs stopped its agent`,
      ),
    );
    await Promise.all([cancelled.completion, survivor.completion]);

    service("stop");
    serviceRunning = false;
    serviceEnv = env;
    console.log(
      `cancellation matrix: CLI cancel stopped a real Codex driver's launcher, app server and child in ${stopMs}ms; the agent step failed once with no retry or successor, and another Codex run finished`,
    );
  }

  function service(action) {
    const result = runCli(["service", action], serviceEnv, {
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
  assert.equal(report.entries[0].state, action === "remove" ? "released" : "kept");
  assert.equal(report.entries[0].eligible, eligible);
  if (action !== undefined) assert.equal(report.entries[0].action, action);
}

function runtimeEnv(postgresUrl, dataHome, ports) {
  return {
    ...process.env,
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
