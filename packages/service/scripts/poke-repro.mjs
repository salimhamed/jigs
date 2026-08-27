#!/usr/bin/env node
// Poke acceptance repro (AGE-314), patterned on suspension-repro.mjs:
// a suspension-demo run parks at the PR gate, the mock PR is approved with no
// webhook delivered, and the built `jigs poke <run>` CLI wakes it end to end.
// Also asserts poke exits nonzero for an unknown run and for a run holding no
// suspensions. Requires `pnpm build`, compose Postgres up, bootstrap.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  assert,
  createHarness,
  startLinearGithubStub,
  waitFor,
  waitForLog,
} from "./repro-lib.mjs";

const execFileAsync = promisify(execFile);

const { mock, env } = await startLinearGithubStub();

function approvePr() {
  mock.pr.reviews.push({
    id: 1,
    state: "APPROVED",
    body: "",
    user: { login: "reviewer" },
    submitted_at: new Date().toISOString(),
  });
}

// ---- service harness (shared with crash/suspension repros) ------------------

const PORT = process.env.PORT ?? "8994";
const { base, startServer, healthy, ensurePortFree, api } = createHarness({
  port: PORT,
  env,
});

await ensurePortFree();

const issueId = crypto.randomUUID();
// Random per invocation: suspended runs from earlier invocations survive in
// Postgres and keep their resource claims (that persistence is the point).
const pr = {
  owner: "acme",
  repo: "api",
  number: Math.floor(Math.random() * 1_000_000) + 1,
};

const poke = (runId) =>
  execFileAsync(
    "node",
    ["../jigs/dist/cli.js", "poke", runId, "--service", base],
    { env: process.env },
  ).then(
    ({ stdout }) => ({ code: 0, output: stdout }),
    (err) => ({ code: err.code ?? 1, output: `${err.stdout}${err.stderr}` }),
  );

const server = startServer("run1");
await healthy();

const run = await api("/api/pipelines/suspension-demo/runs", {
  inputs: { issueId, pr },
});
await waitForLog(server, /\[prGate\] fetched/);

// Approved on the provider, but no webhook delivered — the missed-delivery gap
// that poke exists to cover.
approvePr();
const poked = await poke(run.runId);
assert(poked.code === 0, `poke exits 0 (${poked.output.trim()})`);
assert(
  poked.output.includes(`github:pr:${pr.owner}/${pr.repo}#${pr.number}`),
  "poke prints the gate token it resumed",
);

const final = await waitFor(async () => {
  const r = await api(`/api/runs/${run.runId}`);
  return r.status === "completed" ? r : null;
}, "run completion after the poke");
assert(
  final.returnValue.wakes.some((w) => w.kind === "approved"),
  "the poked wake re-checked the provider and delivered the approval",
);

const unknown = await poke("wr_definitely_not_a_run");
assert(unknown.code !== 0, "poke of an unknown run exits nonzero");
assert(
  unknown.output.includes("not found"),
  "unknown-run failure names the run as not found",
);

const completed = await poke(run.runId);
assert(completed.code !== 0, "poke of a run with no suspensions exits nonzero");
assert(
  completed.output.includes("no suspensions"),
  "no-suspensions failure says so",
);

console.log("\nPASS: poke");
server.child.kill("SIGKILL");
process.exit(0);
