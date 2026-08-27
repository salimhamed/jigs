#!/usr/bin/env node
// CLI verb acceptance repro (AGE-317), patterned on poke-repro.mjs: the built
// `jigs` CLI drives a real service end to end —
//   run     launches a pipeline, and a schema violation is refused client-side
//   ps      lists the run and a seeded abandoned-dirty worktree
//   logs    resolves a ticket id and a ULID prefix, and errors on an ambiguous one
//   cancel  releases a suspended run's claim, so the same ticket relaunches
// Requires `pnpm build` (both packages), compose Postgres up, bootstrap.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import postgres from "postgres";
import { assert, createHarness, waitFor, waitForLog } from "./repro-lib.mjs";

const execFileAsync = promisify(execFile);

// ---- mock Linear + GitHub provider server ----------------------------------

const mock = {
  creator: { id: "creator-1", name: "salim" },
  viewer: { id: "bot-1" },
  comments: [],
  pr: { state: "open", merged: false, reviews: [] },
};

const mockServer = createServer(async (req, res) => {
  const json = (body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST" && req.url === "/graphql") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const { query } = JSON.parse(raw);
    if (query.includes("comments")) {
      return json({ data: { issue: { comments: { nodes: mock.comments } } } });
    }
    return json({
      data: { issue: { creator: mock.creator }, viewer: mock.viewer },
    });
  }
  if (req.method === "GET" && req.url === "/github/user") {
    return json({ login: "jigs-bot" });
  }
  if (req.method === "GET" && req.url?.startsWith("/github/repos/")) {
    if (req.url.includes("/reviews")) return json(mock.pr.reviews);
    return json({ state: mock.pr.state, merged: mock.pr.merged });
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => mockServer.listen(0, resolve));
const MOCK_BASE = `http://localhost:${mockServer.address().port}`;

// ---- service harness --------------------------------------------------------

const PG_URL =
  process.env.WORKFLOW_POSTGRES_URL ??
  "postgres://jigs:jigs@localhost:5439/jigs";
const { base, startServer, healthy, ensurePortFree, api } = createHarness({
  port: process.env.PORT ?? "8995",
  env: {
    LINEAR_API_KEY: "mock-linear-key",
    GITHUB_TOKEN: "mock-github-token",
    LINEAR_API_URL: `${MOCK_BASE}/graphql`,
    GITHUB_API_URL: `${MOCK_BASE}/github`,
  },
});
process.on("exit", () => mockServer.close());

await ensurePortFree();

const jigs = (...args) =>
  execFileAsync("node", ["../jigs/dist/cli.js", ...args], {
    env: { ...process.env, JIGS_SERVICE_URL: base },
  }).then(
    ({ stdout }) => ({ code: 0, output: stdout }),
    (err) => ({ code: err.code ?? 1, output: `${err.stdout}${err.stderr}` }),
  );

const issueId = crypto.randomUUID();
// Random per invocation: suspended runs from earlier invocations survive in
// Postgres and keep their resource claims (that persistence is the point).
const pr = {
  owner: "acme",
  repo: "api",
  number: Math.floor(Math.random() * 1_000_000) + 1,
};

const server = startServer("service");
await healthy();

// ---- run --------------------------------------------------------------------

const before = await api("/api/runs");

const rejected = await jigs(
  "run",
  "suspension-demo",
  "--input",
  "issueId=AGE-123",
);
assert(rejected.code !== 0, "a schema violation exits nonzero");
assert(
  rejected.output.includes("Invalid UUID"),
  "the failure carries the schema's own error",
);
const after = await api("/api/runs");
assert(
  after.runs.length === before.runs.length,
  "no run was created by the refused launch",
);

const unknown = await jigs("run", "no-such-pipeline");
assert(unknown.code !== 0, "an unknown pipeline exits nonzero");
assert(
  unknown.output.includes("known pipelines:"),
  "the unknown-pipeline failure lists what the service does host",
);

const launched = await jigs(
  "run",
  "suspension-demo",
  "--input",
  `issueId=${issueId}`,
  "--input",
  `pr=${JSON.stringify(pr)}`,
);
assert(launched.code === 0, `jigs run exits 0 (${launched.output.trim()})`);
const runId = launched.output.match(/^run (\S+)/m)?.[1];
assert(runId !== undefined, `jigs run prints the run id (${runId})`);
assert(
  launched.output.includes("npx workflow web"),
  "jigs run points at the log surface",
);
await waitForLog(server, /\[prGate\] fetched/);

// ---- ps ---------------------------------------------------------------------

const worktreePath = `/tmp/jigs-cli-repro/${runId}`;
const sql = postgres(PG_URL);
await sql`
  INSERT INTO jigs_worktrees
    (path, branch, owner_run_id, state, base_sha, head_sha, behind_default)
  VALUES
    (${worktreePath}, 'salim/age-317', ${runId}, 'abandoned-dirty',
     'aaaa', 'bbbb', 0)
  ON CONFLICT (path) DO UPDATE SET state = 'abandoned-dirty'
`;
await sql.end();

const ps = await jigs("ps");
assert(ps.code === 0, "jigs ps exits 0");
const runLine = ps.output.split("\n").find((line) => line.startsWith(runId));
assert(
  runLine?.includes("suspension-demo"),
  "ps names the pipeline, not the compiled workflow id",
);
assert(runLine?.includes("suspended"), "ps shows the parked run as suspended");
const worktreeLine = ps.output
  .split("\n")
  .find((line) => line.startsWith(worktreePath));
assert(
  worktreeLine?.includes("abandoned-dirty"),
  "ps shows the abandoned-dirty worktree",
);

// ---- run identity -----------------------------------------------------------

const byTicket = await jigs("logs", issueId);
assert(byTicket.code === 0, "a ticket id resolves");
assert(byTicket.output.includes(runId), "the ticket id resolves to its run");
assert(
  byTicket.output.includes("npx workflow web"),
  "logs hands over to the SDK's log surface",
);

const byPrefix = await jigs("logs", runId.slice(0, 20));
assert(byPrefix.code === 0, "a unique ULID prefix resolves");
assert(byPrefix.output.includes(runId), "the prefix resolves to the same run");

// Every ULID this world minted starts `01`, so two characters name every run
// at once — as long as more than one has ever been launched here.
const listed = await api("/api/runs");
if (listed.runs.length > 1) {
  const ambiguous = await jigs("logs", "01");
  assert(ambiguous.code !== 0, "an ambiguous prefix exits nonzero");
  assert(
    ambiguous.output.includes("use more characters"),
    "the ambiguous-prefix failure says how to disambiguate",
  );
} else {
  console.log("  skip: only one run in this world, no ambiguous prefix");
}

// ---- cancel -----------------------------------------------------------------

const cancelled = await jigs("cancel", issueId);
assert(
  cancelled.code === 0,
  `jigs cancel exits 0 (${cancelled.output.trim()})`,
);
assert(
  cancelled.output.includes(`released linear:ticket:${issueId}`),
  "cancel reports the released ticket claim",
);

const again = await jigs("cancel", runId, "--force");
assert(again.code !== 0, "cancelling a cancelled run exits nonzero");
assert(
  again.output.includes("already cancelled"),
  "the refusal names the terminal status",
);

// The claim is what a zombie owner holds hostage; a fresh run on the same
// ticket is the only honest proof the cancel released it.
const relaunched = await jigs(
  "run",
  "suspension-demo",
  "--input",
  `issueId=${issueId}`,
  "--input",
  `pr=${JSON.stringify(pr)}`,
);
assert(relaunched.code === 0, "a new run on the same ticket launches");
const newRunId = relaunched.output.match(/^run (\S+)/m)?.[1];
const claimed = await waitFor(async () => {
  const run = await api(`/api/runs/${newRunId}`);
  if (run.status === "failed") throw new Error(`relaunch failed: ${run.error}`);
  return (run.suspensions ?? []).some(
    (s) => s.satisfiedBy === `linear:ticket:${issueId}`,
  )
    ? run
    : null;
}, "the relaunched run to hold the ticket claim");
assert(
  claimed.suspensions.length > 0,
  "the relaunched run holds the claim the cancel released",
);
await jigs("cancel", newRunId, "--force");

console.log("\nPASS: verbs");
server.child.kill("SIGKILL");
process.exit(0);
