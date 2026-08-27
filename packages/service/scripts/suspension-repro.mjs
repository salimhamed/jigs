#!/usr/bin/env node
// Suspension acceptance repro (AGE-312), patterned on crash-repro.mjs:
//   conflict         second run on the same ticket fails fast naming the owner
//   unsatisfied-wake a wake with unchanged provider state re-suspends, no consumer wake
//   gate-restart     a gate survives SIGKILL and receives the next wake
//   needs-human      Linear comment with @-mention, visible suspension, reply satisfies
// Requires `pnpm build`, compose Postgres up, bootstrap. Providers are mocked
// in-process and fed to the service via LINEAR_API_URL / GITHUB_API_URL.
import { createServer } from "node:http";
import { assert, createHarness, waitFor, waitForLog } from "./repro-lib.mjs";

const mode = process.argv[2];
const MODES = ["conflict", "unsatisfied-wake", "gate-restart", "needs-human"];
if (!MODES.includes(mode)) {
  console.error(`usage: node scripts/suspension-repro.mjs ${MODES.join("|")}`);
  process.exit(2);
}

// ---- mock Linear + GitHub provider server ----------------------------------

const mock = {
  creator: { id: "creator-1", name: "salim" },
  viewer: { id: "bot-1" },
  comments: [],
  createdComments: [],
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
    const { query, variables } = JSON.parse(raw);
    if (query.includes("commentCreate")) {
      const comment = {
        id: `bot-comment-${mock.createdComments.length + 1}`,
        body: variables.input.body,
        createdAt: new Date().toISOString(),
        user: { id: mock.viewer.id, name: "jigs" },
      };
      mock.comments.push(comment);
      mock.createdComments.push(comment);
      return json({
        data: {
          commentCreate: {
            success: true,
            comment: { id: comment.id, createdAt: comment.createdAt },
          },
        },
      });
    }
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

function addHumanComment(body) {
  mock.comments.push({
    id: `human-comment-${mock.comments.length + 1}`,
    body,
    createdAt: new Date().toISOString(),
    user: mock.creator,
  });
}

function approvePr() {
  mock.pr.reviews.push({
    id: mock.pr.reviews.length + 1,
    state: "APPROVED",
    body: "",
    user: { login: "reviewer" },
    submitted_at: new Date().toISOString(),
  });
}

// ---- service harness (shared with crash-repro) ------------------------------

const { startServer, healthy, ensurePortFree, api } = createHarness({
  port: process.env.PORT ?? "8993",
  env: {
    LINEAR_API_KEY: "mock-linear-key",
    GITHUB_TOKEN: "mock-github-token",
    LINEAR_API_URL: `${MOCK_BASE}/graphql`,
    GITHUB_API_URL: `${MOCK_BASE}/github`,
  },
});
process.on("exit", () => mockServer.close());

await ensurePortFree();

const issueId = crypto.randomUUID();
// Random per invocation: suspended runs from earlier invocations survive in
// Postgres and keep their resource claims (that persistence is the point).
const pr = {
  owner: "acme",
  repo: "api",
  number: Math.floor(Math.random() * 1_000_000) + 1,
};
const ticketToken = `linear:ticket:${issueId}`;
const prToken = `github:pr:${pr.owner}/${pr.repo}#${pr.number}`;
const resume = (token) =>
  api("/api/hooks/resume", { token, payload: { hint: true } });

let server = startServer("run1");
await healthy();

if (mode === "conflict") {
  const runA = await api("/api/pipelines/suspension-demo/runs", {
    inputs: { issueId, pr },
  });
  await waitForLog(server, /\[prGate\] fetched/);
  const started = Date.now();
  const runB = await api("/api/pipelines/suspension-demo/runs", {
    inputs: { issueId },
  });
  const failed = await waitFor(async () => {
    const run = await api(`/api/runs/${runB.runId}`);
    return run.status === "failed" ? run : null;
  }, "run B to fail");
  const elapsed = Date.now() - started;
  assert(elapsed < 10_000, `second run failed within seconds (${elapsed}ms)`);
  assert(
    String(failed.error).includes(runA.runId),
    `conflict names the owning run (${runA.runId})`,
  );
  assert(
    String(failed.error).includes(ticketToken),
    "conflict names the claimed resource",
  );
  const stillRunning = await api(`/api/runs/${runA.runId}`);
  assert(stillRunning.status === "running", "owning run is unaffected");
}

if (mode === "unsatisfied-wake") {
  const runA = await api("/api/pipelines/suspension-demo/runs", {
    inputs: { issueId, pr },
  });
  await waitForLog(server, /\[prGate\] fetched/);

  await resume(prToken);
  await waitFor(
    () => (server.log.match(/\[prGate\] fetched/g) ?? []).length >= 2,
    "the satisfier re-check on the wake",
  );
  assert(
    !server.log.includes("[suspension-demo] gate wake"),
    "no consumer wake was yielded",
  );
  await new Promise((r) => setTimeout(r, 2000));
  const run = await api(`/api/runs/${runA.runId}`);
  assert(run.status === "running", "unsatisfied wake re-suspended the run");
  assert(
    (run.suspensions ?? []).some((s) => s.key.startsWith("pr-gate:")),
    "re-suspended run still lists the gate suspension",
  );

  approvePr();
  await resume(prToken);
  const final = await waitFor(async () => {
    const r = await api(`/api/runs/${runA.runId}`);
    return r.status === "completed" ? r : null;
  }, "run completion after the satisfied wake");
  assert(
    final.returnValue.wakes.some((w) => w.kind === "approved"),
    "the satisfied wake reached the consumer",
  );
}

if (mode === "gate-restart") {
  const runA = await api("/api/pipelines/suspension-demo/runs", {
    inputs: { issueId, pr },
  });
  await waitForLog(server, /\[prGate\] fetched/);

  server.child.kill("SIGKILL");
  console.log(`  killed pid=${server.child.pid} mid-review`);
  server = startServer("run2");
  await healthy();

  approvePr();
  // The hook may need a beat to be resumable after restart; retry.
  await waitFor(async () => {
    const res = await resume(prToken);
    return res.resumed === true ? res : null;
  }, "hook to accept the resume after restart");
  const final = await waitFor(async () => {
    const r = await api(`/api/runs/${runA.runId}`);
    return r.status === "completed" ? r : null;
  }, "run completion after restart + wake");
  assert(
    final.returnValue.wakes.some((w) => w.kind === "approved"),
    "gate iterator survived the restart and received the next wake",
  );
  assert(
    final.returnValue.claimed === ticketToken,
    "claim held across the restart",
  );
}

if (mode === "needs-human") {
  const runA = await api("/api/pipelines/suspension-demo/runs", {
    inputs: { issueId, askHuman: true },
  });
  await waitFor(
    () => mock.createdComments.length > 0,
    "the Linear comment to be posted",
  );
  const comment = mock.createdComments[0];
  assert(
    comment.body.includes(`@[${mock.creator.name}](${mock.creator.id})`),
    "comment @-mentions the ticket creator",
  );
  assert(
    comment.body.includes("suspension-demo needs a human"),
    "comment carries the reason",
  );

  const suspended = await waitFor(async () => {
    const r = await api(`/api/runs/${runA.runId}`);
    return (r.suspensions ?? []).some((s) => s.key.startsWith("needs-human:"))
      ? r
      : null;
  }, "the needs-human suspension to be visible");
  assert(
    suspended.status === "running",
    "run shows suspended (running + suspension record)",
  );

  await resume(ticketToken);
  await waitForLog(server, /\[needsHuman\] re-check .* found=false/);
  await new Promise((r) => setTimeout(r, 2000));
  const still = await api(`/api/runs/${runA.runId}`);
  assert(still.status === "running", "wake without a human reply re-suspended");

  addHumanComment("looks good, proceed");
  await resume(ticketToken);
  const final = await waitFor(async () => {
    const r = await api(`/api/runs/${runA.runId}`);
    return r.status === "completed" ? r : null;
  }, "run completion after the human reply");
  assert(
    final.returnValue.reply.author.id === mock.creator.id,
    "the human reply satisfied the halt",
  );
  assert(
    final.returnValue.reply.body === "looks good, proceed",
    "reply body delivered to the pipeline",
  );
}

console.log(`\nPASS: ${mode}`);
server.child.kill("SIGKILL");
process.exit(0);
