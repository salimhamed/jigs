#!/usr/bin/env node
// JIT check acceptance repro (AGE-315), patterned on suspension-repro.mjs:
// an agent step whose declared MCP server cannot start halts needs-human —
// the repair is posted to the ticket, the run stays non-terminal (so it
// keeps its worktree), and a human reply re-runs the step from zero.
// Requires `pnpm build`, compose Postgres up, bootstrap. Linear is mocked
// in-process and fed to the service via LINEAR_API_URL.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, createHarness, waitFor, waitForLog } from "./repro-lib.mjs";

// ---- mock Linear -----------------------------------------------------------

const mock = {
  creator: { id: "creator-1", name: "salim" },
  viewer: { id: "bot-1" },
  comments: [],
  botComments: [],
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
        id: `bot-comment-${mock.botComments.length + 1}`,
        body: variables.input.body,
        createdAt: new Date().toISOString(),
        user: { id: mock.viewer.id, name: "jigs" },
      };
      mock.comments.push(comment);
      mock.botComments.push(comment);
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
    if (query.trim().startsWith("query { viewer")) {
      return json({ data: { viewer: mock.viewer } });
    }
    return json({
      data: { issue: { creator: mock.creator }, viewer: mock.viewer },
    });
  }
  if (req.method === "GET" && req.url === "/github/user") {
    return json({ login: "jigs-bot" });
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => mockServer.listen(0, resolve));
const MOCK_BASE = `http://localhost:${mockServer.address().port}`;

// A claude CLI stub reporting a clean subscription login, so preflight's
// harness check is not this script's variable.
const stubDir = mkdtempSync(path.join(tmpdir(), "jigs-jit-"));
const claudeStub = path.join(stubDir, "claude");
writeFileSync(
  claudeStub,
  `#!/bin/sh\necho '{"loggedIn":true,"authMethod":"claude.ai"}'\n`,
);
chmodSync(claudeStub, 0o755);

const { startServer, healthy, ensurePortFree, api } = createHarness({
  port: process.env.PORT ?? "8995",
  env: {
    LINEAR_API_KEY: "mock-linear-key",
    GITHUB_TOKEN: "mock-github-token",
    LINEAR_API_URL: `${MOCK_BASE}/graphql`,
    GITHUB_API_URL: `${MOCK_BASE}/github`,
    JIGS_CLAUDE_EXECUTABLE: claudeStub,
  },
});
process.on("exit", () => mockServer.close());

await ensurePortFree();
const issueId = crypto.randomUUID();
const ticketToken = `linear:ticket:${issueId}`;
const server = startServer("jit");
await healthy();

const trigger = await api("/api/pipelines/jit-demo/runs", {
  inputs: { issueId },
});
assert(
  typeof trigger.runId === "string",
  `preflight passed and the run was created: ${JSON.stringify(trigger)}`,
);

await waitForLog(server, /\[needsHuman\] posted comment=/);
assert(mock.botComments.length === 1, "the halt posted one comment");
const posted = mock.botComments[0].body;
assert(
  posted.includes("MCP server linear"),
  "the posted comment names the failing MCP server",
);
assert(
  posted.includes("→"),
  `the posted comment carries the repair instruction:\n${posted}`,
);

// Non-terminal is the whole point: a suspended run keeps its worktree, a
// failed one does not.
await new Promise((r) => setTimeout(r, 1000));
const halted = await api(`/api/runs/${trigger.runId}`);
assert(
  halted.status === "running",
  `run halted, not failed (status: ${halted.status})`,
);
assert(
  (halted.suspensions ?? []).some((s) => s.key.startsWith("needs-human:")),
  "the run lists its needs-human suspension",
);

// The reply satisfies the halt; the next loop iteration is a fresh step slot,
// so the step re-runs from zero and fails the same way — a second comment.
mock.comments.push({
  id: "human-comment-1",
  body: "fixed it, try again",
  createdAt: new Date().toISOString(),
  user: mock.creator,
});
await api("/api/hooks/resume", { token: ticketToken, payload: { hint: true } });

await waitFor(
  () => mock.botComments.length >= 2,
  "a second needs-human comment from the re-run step",
);
assert(
  mock.botComments.length >= 2,
  "the step re-ran from zero after the human reply",
);
const rerun = await api(`/api/runs/${trigger.runId}`);
assert(rerun.status === "running", "the re-run halted again, still not failed");

console.log("\nPASS: jit");
server.child.kill("SIGKILL");
process.exit(0);
