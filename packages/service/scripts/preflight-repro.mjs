#!/usr/bin/env node
// Preflight acceptance repro (AGE-315), patterned on steps-repro.mjs:
//   refused  a trigger with three seeded failures is refused with all three
//            at once, each carrying a repair, and no run is created
//   green    with the operator's real credentials a trigger creates a run,
//            and `GET /api/doctor` answers without launching anything
// Requires `pnpm build`, compose Postgres up, bootstrap. `green` also needs
// LINEAR_API_KEY and GITHUB_TOKEN in the environment.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, createHarness } from "./repro-lib.mjs";

const mode = process.argv[2];
if (!["refused", "green"].includes(mode)) {
  console.error("usage: node scripts/preflight-repro.mjs refused|green");
  process.exit(2);
}

const seededFactory = mkdtempSync(path.join(tmpdir(), "jigs-preflight-"));
writeFileSync(path.join(seededFactory, "jigs.yml"), "bindings: {}\n");

const seeded = {
  LINEAR_API_KEY: "",
  GITHUB_TOKEN: "",
  JIGS_FACTORY_ROOT: seededFactory,
};

const { startServer, healthy, ensurePortFree, api, base } = createHarness({
  port: process.env.PORT ?? "8994",
  env: mode === "refused" ? seeded : {},
});

await ensurePortFree();
const server = startServer(mode);
await healthy();

if (mode === "refused") {
  const res = await fetch(`${base}/api/pipelines/preflight-demo/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs: {} }),
  });
  assert(res.status === 424, `trigger refused with 424 (got ${res.status})`);
  const body = await res.json();
  const ids = body.failures.map((f) => f.id).sort();
  assert(
    JSON.stringify(ids) ===
      JSON.stringify([
        "binding.api",
        "core.github-token",
        "core.linear-api-key",
      ]),
    `all three seeded failures reported at once: ${ids.join(", ")}`,
  );
  assert(
    body.failures.every((f) => typeof f.repair === "string" && f.repair !== ""),
    "every failure carries a repair instruction",
  );
  assert(
    body.failures
      .find((f) => f.id === "binding.api")
      .repair.includes("--name api"),
    "the undeclared binding names the exact jigs bind invocation",
  );
  assert(body.runId === undefined, "no run id was handed back");
  assert(
    !server.log.includes("Starting workflow"),
    "no run was created (nothing started)",
  );

  const doctor = await api("/api/doctor");
  assert(doctor.ok === false, "jigs doctor reports red on the same failures");
  assert(
    doctor.checks.some((c) => c.id === "harness.codex-auth"),
    "doctor runs the whole catalog, not one pipeline's manifest",
  );
} else {
  if (!process.env.LINEAR_API_KEY || !process.env.GITHUB_TOKEN) {
    console.error(
      "SKIP: green needs real LINEAR_API_KEY and GITHUB_TOKEN in the environment",
    );
    process.exit(2);
  }
  const doctor = await api("/api/doctor");
  console.log(`  doctor: ${JSON.stringify(doctor, null, 2)}`);
  assert(typeof doctor.ok === "boolean", "doctor answered without a launch");

  const trigger = await api("/api/pipelines/steps-demo/runs", {
    inputs: { mode: "replay" },
  });
  assert(
    typeof trigger.runId === "string",
    `a green preflight created a run: ${JSON.stringify(trigger)}`,
  );
}

console.log(`\nPASS: ${mode}`);
server.child.kill("SIGKILL");
process.exit(0);
