#!/usr/bin/env node
// Crash-model repro: `suspension` kills while suspended at the hook and
// asserts memoized replay; `midstep` kills mid-step and asserts a rescue
// re-run from zero. Requires `pnpm build`, compose Postgres up, bootstrap.
import { spawn } from "node:child_process";

const mode = process.argv[2];
if (!["suspension", "midstep"].includes(mode)) {
  console.error("usage: node scripts/crash-repro.mjs suspension|midstep");
  process.exit(2);
}

const PORT = process.env.PORT ?? "8992";
const BASE = `http://localhost:${PORT}`;
const env = {
  ...process.env,
  PORT,
  WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
  WORKFLOW_POSTGRES_URL:
    process.env.WORKFLOW_POSTGRES_URL ??
    "postgres://jigs:jigs@localhost:5439/jigs",
};

const children = [];
process.on("exit", () => {
  for (const child of children) child.kill("SIGKILL");
});

function startServer(label) {
  const child = spawn("node", [".output/server/index.mjs"], { env });
  children.push(child);
  const state = { child, log: "" };
  const capture = (chunk) => {
    state.log += chunk;
    process.stdout.write(`  [${label}] ${chunk}`);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return state;
}

async function waitFor(fn, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const waitForLog = (server, regex, timeoutMs) =>
  waitFor(() => server.log.match(regex), regex, timeoutMs);

const healthy = () =>
  waitFor(
    () =>
      fetch(`${BASE}/health`)
        .then((r) => r.ok)
        .catch(() => false),
    "/health",
  );

async function api(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function assert(cond, message) {
  if (!cond) {
    console.error(`\nFAIL: ${message}`);
    process.exit(1);
  }
  console.log(`  ok: ${message}`);
}

const START_RE = /\[slowStep\] START \S+ marker=([0-9a-f-]+)/;

if (
  await fetch(`${BASE}/health`)
    .then((r) => r.ok)
    .catch(() => false)
) {
  console.error(`FAIL: something already listens on ${BASE} — stop it first`);
  process.exit(2);
}

const stepSeconds = mode === "suspension" ? 2 : 8;
let server = startServer("run1");
await healthy();

const trigger = await api("/api/pipelines/demo-crash/runs", {
  inputs: { stepSeconds },
});
console.log(`  triggered: ${JSON.stringify(trigger)}`);

if (mode === "suspension") {
  await waitForLog(server, /\[slowStep\] END/);
} else {
  await waitForLog(server, START_RE);
}
const preKillMarker = server.log.match(START_RE)[1];

server.child.kill("SIGKILL");
console.log(`  killed pid=${server.child.pid} (${mode})`);

server = startServer("run2");
await healthy();

if (mode === "midstep") {
  await waitForLog(server, /Re-enqueued \d+ active run/);
  const rerun = await waitForLog(server, /\[slowStep\] END/, 60_000);
  const rerunMarker = server.log.match(START_RE)[1];
  assert(rerun, "startup rescue re-ran the in-flight step");
  assert(
    rerunMarker !== preKillMarker,
    `step re-ran from zero (marker ${rerunMarker} != pre-kill ${preKillMarker})`,
  );
}

// The hook 404s until the pipeline body reaches createHook; retry.
const resumed = await waitFor(async () => {
  const res = await api("/api/hooks/resume", {
    token: trigger.resumeToken,
    payload: { approved: true, note: `crash-repro ${mode}` },
  });
  return res.resumed === true ? res : null;
}, "hook to accept the resume");
assert(resumed.resumed === true, "resumeHook accepted the token");

const final = await waitFor(async () => {
  const run = await api(`/api/runs/${trigger.runId}`);
  return run.status === "completed" ? run : null;
}, "run completion");

const finalMarker = final.returnValue.slowStep.marker;
if (mode === "suspension") {
  assert(
    finalMarker === preKillMarker,
    `pre-kill step result replayed verbatim (marker ${finalMarker})`,
  );
  assert(
    !START_RE.test(server.log),
    "slowStep did not re-execute after restart",
  );
} else {
  assert(
    finalMarker !== preKillMarker,
    `completed with the re-run attempt's marker (${finalMarker})`,
  );
}
assert(
  final.returnValue.finalStep.sawMarker === finalMarker,
  "downstream step saw the surviving marker",
);

console.log(`\nPASS: ${mode}`);
server.child.kill("SIGKILL");
process.exit(0);
