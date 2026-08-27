#!/usr/bin/env node
// Crash-model repro: `suspension` kills while suspended at the hook and
// asserts memoized replay; `midstep` kills mid-step and asserts a rescue
// re-run from zero. Requires `pnpm build`, compose Postgres up, bootstrap.
import {
  assert,
  createHarness,
  startProviderStub,
  waitFor,
  waitForLog,
} from "./repro-lib.mjs";

const mode = process.argv[2];
if (!["suspension", "midstep"].includes(mode)) {
  console.error("usage: node scripts/crash-repro.mjs suspension|midstep");
  process.exit(2);
}

const { startServer, healthy, ensurePortFree, api } = createHarness({
  port: process.env.PORT ?? "8992",
  env: await startProviderStub(),
});

const START_RE = /\[slowStep\] START \S+ marker=([0-9a-f-]+)/;

await ensurePortFree();

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
