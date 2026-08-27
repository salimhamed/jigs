#!/usr/bin/env node
// Ticket-snapshot acceptance repro (AGE-313), patterned on jit-repro.mjs: a
// run fetches the ticket, halts needs-human, and fetches it again on the
// resume — the resume-time copy carries the human's reply while the
// launch-time copy comes back unchanged from its own step record.
// Requires `pnpm build`, compose Postgres up, bootstrap. Linear is mocked
// in-process and fed to the service via LINEAR_API_URL.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, createHarness, waitFor, waitForLog } from "./repro-lib.mjs";

// ---- mock Linear -----------------------------------------------------------

// Random per invocation: suspended runs from earlier invocations survive in
// Postgres and keep their claim on the ticket.
const issueId = crypto.randomUUID();
const mock = {
  creator: { id: "creator-1", name: "salim" },
  viewer: { id: "bot-1" },
  comments: [
    {
      id: "seed-comment-1",
      body: "the ticket already had this comment at launch",
      createdAt: new Date().toISOString(),
      user: { id: "creator-1", name: "salim" },
    },
  ],
  botComments: [],
};

const issueSnapshot = () => ({
  id: issueId,
  identifier: "AGE-313",
  title: "Ticket snapshot and the ticketReview jig",
  description: "## Scope\n\nFetch the ticket on each activation.",
  url: "https://linear.app/x/issue/AGE-313",
  branchName: "salimhamed/age-313-ticket-snapshot",
  state: { name: "Todo" },
  labels: { nodes: [{ name: "ready-for-agent" }] },
  comments: { nodes: mock.comments },
  attachments: { nodes: [] },
  children: { nodes: [] },
  relations: { nodes: [] },
  inverseRelations: { nodes: [] },
});

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
    // Before the bare `comments` branch: the snapshot query asks for comments too.
    if (query.includes("IssueSnapshot")) {
      return json({ data: { issue: issueSnapshot() } });
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

// A claude CLI stub reporting a clean subscription login: snapshot-only runs
// no agent step, but the pipeline's `requires` manifest still gates the
// trigger on the harness check.
const stubDir = mkdtempSync(path.join(tmpdir(), "jigs-ticket-review-"));
const claudeStub = path.join(stubDir, "claude");
writeFileSync(
  claudeStub,
  `#!/bin/sh\necho '{"loggedIn":true,"authMethod":"claude.ai"}'\n`,
);
chmodSync(claudeStub, 0o755);

const { startServer, healthy, ensurePortFree, api } = createHarness({
  port: process.env.PORT ?? "8996",
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
const ticketToken = `linear:ticket:${issueId}`;
const server = startServer("ticket-review");
await healthy();

const trigger = await api("/api/pipelines/ticket-review-demo/runs", {
  inputs: { issueId, cwd: process.cwd(), mode: "snapshot-only" },
});
assert(
  typeof trigger.runId === "string",
  `preflight passed and the run was created: ${JSON.stringify(trigger)}`,
);

await waitForLog(server, /\[snapshot\] fetched issue=/);
await waitFor(
  () => mock.botComments.length > 0,
  "the needs-human comment to be posted",
);

const humanComment = {
  id: "human-comment-1",
  body: "answering: yes, cap comments at 100",
  createdAt: new Date().toISOString(),
  user: mock.creator,
};
mock.comments.push(humanComment);
await api("/api/hooks/resume", { token: ticketToken, payload: { hint: true } });

const final = await waitFor(async () => {
  const run = await api(`/api/runs/${trigger.runId}`);
  return run.status === "completed" ? run : null;
}, "run completion after the human reply");

const { launchComments, resumedComments } = final.returnValue;
assert(
  launchComments.includes("seed-comment-1"),
  "the launch-time copy carries the comments the ticket had at launch",
);
assert(
  resumedComments.includes(humanComment.id),
  "the resume-time copy carries the human's reply",
);
assert(
  !launchComments.includes(humanComment.id),
  "the launch-time copy came back from its own step record, without the reply",
);

console.log("\nPASS: ticket-review");
server.child.kill("SIGKILL");
process.exit(0);
