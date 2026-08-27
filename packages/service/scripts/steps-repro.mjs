#!/usr/bin/env node
// Step-builder acceptance repro (AGE-311), patterned on crash-repro.mjs:
//   replay      a completed fn step is not re-executed on resume; the
//               recorded StepResult comes back verbatim, and a recorded
//               AgentStepResult (usage, session, files) survives the World's
//               step-record serialization into durable run state
//   bad-config  a live function smuggled into agent() config fails the run
//               at the SDK serialization boundary, before any harness spawns
// Requires `pnpm build`, compose Postgres up, bootstrap.
import {
  assert,
  createHarness,
  startProviderStub,
  waitFor,
  waitForLog,
} from "./repro-lib.mjs";

const mode = process.argv[2];
if (!["replay", "bad-config"].includes(mode)) {
  console.error("usage: node scripts/steps-repro.mjs replay|bad-config");
  process.exit(2);
}

const { startServer, healthy, ensurePortFree, api } = createHarness({
  port: process.env.PORT ?? "8993",
  env: await startProviderStub(),
});

const START_RE = /\[fnStep\] START marker=([0-9a-f-]+)/g;

await ensurePortFree();

const server = startServer("run1");
await healthy();

const trigger = await api("/api/pipelines/steps-demo/runs", {
  inputs: { mode },
});
console.log(`  triggered: ${JSON.stringify(trigger)}`);

if (mode === "bad-config") {
  // The boundary rejects the config with a precise error naming the smuggled
  // field. workflow@4.8.4 then retries the un-retryable and never transitions
  // the run to `failed` (the ADR 0008 known cost, observed for step arguments
  // too), so the assertions target the error and the blocked run, not a
  // terminal status.
  await waitForLog(
    server,
    /Failed to serialize step arguments at path \\?"\.args\[0\]\.harness\.onSpawn\\?"/,
  );
  assert(true, "precise boundary error names the smuggled function field");
  assert(
    !server.log.includes("[fnStep]"),
    "no step executed before the boundary rejected the config",
  );
  // One sample right after the error proves nothing — poll to show the run
  // stays blocked rather than completing moments later.
  for (let poll = 1; poll <= 3; poll++) {
    const run = await api(`/api/runs/${trigger.runId}`);
    assert(
      run.status !== "completed",
      `run stays blocked at the boundary (poll ${poll}/3, status: ${run.status})`,
    );
    if (poll < 3) await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`\nPASS: ${mode}`);
  server.child.kill("SIGKILL");
  process.exit(0);
}

await waitForLog(server, /\[fnStep\] START marker=/);
const preResumeMarker = [...server.log.matchAll(START_RE)][0][1];

// The suspension at the hook plus the resume forces a full body replay: the
// completed fn step must return its recorded StepResult, not run again.
const resumed = await waitFor(async () => {
  const res = await api("/api/hooks/resume", {
    token: trigger.resumeToken,
    payload: { note: `steps-repro ${mode}` },
  });
  return res.resumed === true ? res : null;
}, "hook to accept the resume");
assert(resumed.resumed === true, "resumeHook accepted the token");

const final = await waitFor(async () => {
  const run = await api(`/api/runs/${trigger.runId}`);
  return run.status === "completed" ? run : null;
}, "run completion");

const startLines = [...server.log.matchAll(START_RE)];
assert(
  startLines.length === 1,
  `fn step executed exactly once (saw ${startLines.length} START lines)`,
);
const agentStarts = [...server.log.matchAll(/\[agentShape\] START/g)];
assert(
  agentStarts.length === 1,
  `agent-shaped step executed exactly once (saw ${agentStarts.length} START lines)`,
);
assert(
  final.returnValue.first.output.marker === preResumeMarker,
  `recorded StepResult replayed verbatim (marker ${preResumeMarker})`,
);
assert(
  final.returnValue.second.output.echoed === preResumeMarker,
  "downstream step consumed the replayed marker",
);
assert(
  final.returnValue.first.text === "" &&
    Array.isArray(final.returnValue.first.files),
  "fn StepResult carries the uniform shape",
);

// AC4 at the run-state level: the recorded AgentStepResult shape (from
// echoAgentResult in steps-demo.ts) survives the World's step-record
// serialization into durable run state verbatim.
const shape = final.returnValue.agentShape;
assert(
  typeof shape?.usage?.outputTokens === "number" &&
    shape.usage.outputTokens === 5 &&
    shape.usage.inputTokens === 17 &&
    shape.usage.totalTokens === 22,
  "agent usage survives into durable run state with numeric token counts",
);
assert(
  shape.session?.harness === "claude" &&
    shape.session?.id === "claude-session-0000",
  "agent session pointer survives into durable run state intact",
);
assert(
  shape.files?.[0]?.mediaType === "text/plain" &&
    shape.files?.[0]?.base64 === "aGk=",
  "agent files entry survives into durable run state intact",
);

console.log(`\nPASS: ${mode}`);
server.child.kill("SIGKILL");
process.exit(0);
