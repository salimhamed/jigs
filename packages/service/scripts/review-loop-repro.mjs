#!/usr/bin/env node
// Review-loop acceptance repro (AGE-316), patterned on worktree-repro.mjs. One
// scratch target repo it creates itself, a stubbed Linear + GitHub, and
// scripted agent turns, so the whole shape runs without burning agent turns:
//   answer          a review comment is answered as a threaded reply
//   stale-resume    every resume fails; the fresh-context fallback still answers
//   ci-escalation   four consecutive reds → three fixes, then one @-mention
//   approve-merge   approval → squash merge → worktree and both branches gone
//   close-unmerged  a PR closed unmerged fails the run on the failed rows
// Requires `pnpm build`, compose Postgres up, bootstrap.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, createHarness, waitFor, waitForLog } from "./repro-lib.mjs";

const mode = process.argv[2];
const MODES = [
  "answer",
  "stale-resume",
  "ci-escalation",
  "approve-merge",
  "close-unmerged",
];
if (!MODES.includes(mode)) {
  console.error(`usage: node scripts/review-loop-repro.mjs ${MODES.join("|")}`);
  process.exit(2);
}

const BRANCH = `jigs/review-loop-repro-${Date.now()}`;
const issueId = crypto.randomUUID();

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();

// ---- a bare remote plus a checkout, bound in a throwaway factory repo -------

const root = mkdtempSync(path.join(tmpdir(), "jigs-review-loop-repro-"));
const remoteDir = path.join(root, "remote.git");
const checkout = path.join(root, "scratch");
const workspace = path.join(root, "worktrees");
const factory = path.join(root, "factory");
for (const dir of [remoteDir, checkout, factory]) {
  mkdirSync(dir, { recursive: true });
}
git(remoteDir, "init", "-q", "--bare", "--initial-branch", "main");
git(checkout, "init", "-q", "--initial-branch", "main");
git(checkout, "config", "user.name", "jigs-repro");
git(checkout, "config", "user.email", "repro@jigs.test");
git(checkout, "remote", "add", "origin", remoteDir);
writeFileSync(path.join(checkout, "README.md"), "# scratch\n");
git(checkout, "add", "README.md");
git(checkout, "commit", "-q", "-m", "initial");
git(checkout, "push", "-q", "-u", "origin", "main");
git(checkout, "remote", "set-head", "origin", "main");
writeFileSync(
  path.join(factory, "jigs.yml"),
  `bindings:\n  scratch:\n    path: ${checkout}\n    remote: ${remoteDir}\n    workspace_dir: ${workspace}\n`,
);

// ---- mock Linear + GitHub ---------------------------------------------------

const mock = {
  creator: { id: "creator-1", name: "salim" },
  viewer: { id: "bot-1" },
  comments: [],
  pr: {
    number: 0,
    state: "open",
    merged: false,
    headSha: "head-1",
    reviews: [],
    comments: [],
    checkRuns: [],
  },
  writes: [],
};

const issueSnapshot = () => ({
  id: issueId,
  identifier: "AGE-316",
  title: "Review loop jig",
  description: "## Acceptance criteria\n\n- the builder answers in-thread",
  url: "https://linear.app/x/issue/AGE-316",
  branchName: BRANCH,
  state: { name: "Todo" },
  labels: { nodes: [] },
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
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const url = req.url ?? "";

  if (req.method === "POST" && url === "/graphql") {
    const { query, variables } = JSON.parse(raw);
    if (query.includes("commentCreate")) {
      const comment = {
        id: `bot-comment-${mock.comments.length + 1}`,
        body: variables.input.body,
        createdAt: new Date().toISOString(),
        user: { id: mock.viewer.id, name: "jigs" },
      };
      mock.comments.push(comment);
      return json({
        data: {
          commentCreate: {
            success: true,
            comment: { id: comment.id, createdAt: comment.createdAt },
          },
        },
      });
    }
    if (query.includes("IssueSnapshot")) {
      return json({ data: { issue: issueSnapshot() } });
    }
    if (query.includes("comments")) {
      return json({ data: { issue: { comments: { nodes: mock.comments } } } });
    }
    return json({
      data: { issue: { creator: mock.creator }, viewer: mock.viewer },
    });
  }

  if (req.method === "GET" && url === "/github/user") {
    return json({ login: "jigs-bot" });
  }
  if (
    req.method === "POST" &&
    /\/github\/repos\/[^/]+\/[^/]+\/pulls$/.test(url)
  ) {
    mock.writes.push({ method: "POST", url, body: JSON.parse(raw) });
    mock.pr.number = 41;
    return json({ number: mock.pr.number });
  }
  if (req.method === "POST" && url.includes("/replies")) {
    mock.writes.push({ method: "POST", url, body: JSON.parse(raw) });
    return json({ id: mock.pr.comments.length + 900 });
  }
  if (req.method === "POST" && url.includes("/issues/")) {
    mock.writes.push({ method: "POST", url, body: JSON.parse(raw) });
    return json({ id: 1 });
  }
  if (req.method === "PUT" && url.endsWith("/merge")) {
    mock.writes.push({ method: "PUT", url, body: JSON.parse(raw) });
    mock.pr.state = "closed";
    mock.pr.merged = true;
    // What GitHub's squash merge does to the branch: the work lands on main
    // without the branch tip becoming an ancestor of it.
    git(checkout, "fetch", "-q", "origin", BRANCH);
    git(checkout, "merge", "--squash", "FETCH_HEAD");
    git(checkout, "commit", "-q", "-m", "squashed (#41)");
    git(checkout, "push", "-q", "origin", "main");
    return json({ merged: true, sha: git(checkout, "rev-parse", "HEAD") });
  }
  if (req.method === "GET" && url.includes("/check-runs")) {
    return json({ check_runs: mock.pr.checkRuns });
  }
  if (req.method === "GET" && url.includes("/comments")) {
    return json(mock.pr.comments);
  }
  if (req.method === "GET" && url.includes("/reviews")) {
    return json(mock.pr.reviews);
  }
  if (req.method === "GET" && url.startsWith("/github/repos/")) {
    return json({
      state: mock.pr.state,
      merged: mock.pr.merged,
      head: { sha: mock.pr.headSha },
    });
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => mockServer.listen(0, resolve));
const MOCK_BASE = `http://localhost:${mockServer.address().port}`;

// A claude CLI stub reporting a clean subscription login: the scripted lane
// runs no agent, but `requires` still gates the trigger on the harness check.
const claudeStub = path.join(root, "claude");
writeFileSync(
  claudeStub,
  `#!/bin/sh\necho '{"loggedIn":true,"authMethod":"claude.ai"}'\n`,
);
execFileSync("chmod", ["+x", claudeStub]);

const { startServer, healthy, ensurePortFree, api } = createHarness({
  port: process.env.PORT ?? "8994",
  env: {
    LINEAR_API_KEY: "mock-linear-key",
    GITHUB_TOKEN: "mock-github-token",
    LINEAR_API_URL: `${MOCK_BASE}/graphql`,
    GITHUB_API_URL: `${MOCK_BASE}/github`,
    JIGS_CLAUDE_EXECUTABLE: claudeStub,
    JIGS_FACTORY_ROOT: factory,
    // Off: the per-run teardown is what this repro is about, and the sweep
    // timer would answer for it.
    JIGS_SWEEP_INTERVAL_MS: "0",
  },
});
process.on("exit", () => mockServer.close());

await ensurePortFree();
const server = startServer("review-loop");
await healthy();

const prToken = () => `github:pr:jigs/scratch#${mock.pr.number}`;
const poke = () =>
  api("/api/hooks/resume", { token: prToken(), payload: { hint: true } });
const writes = (predicate) => mock.writes.filter(predicate);

// The dev world is shared and durable: a review-loop run left over from an
// earlier invocation would open its own pull request against this stub and
// claim the same PR token. Its factory root is long gone, so it can only fail.
const { runs } = await api("/api/runs");
for (const row of runs) {
  if (row.pipeline !== "review-loop-demo") continue;
  if (["completed", "failed", "cancelled"].includes(row.status)) continue;
  await api(`/api/runs/${row.runId}/cancel`, {});
  console.log(`  cancelled a leftover run: ${row.runId}`);
}

const trigger = await api("/api/pipelines/review-loop-demo/runs", {
  inputs: {
    issueId,
    binding: "scratch",
    agents: "scripted",
    staleResume: mode === "stale-resume",
    merge: mode === "close-unmerged" ? "human" : "jigs",
  },
});
assert(
  typeof trigger.runId === "string",
  `preflight passed and the run was created: ${JSON.stringify(trigger)}`,
);

const opened = await waitForLog(server, /\[reviewLoop\] opened PR \S+#(\d+)/);
assert(
  writes((w) => w.url.endsWith("/pulls")).length === 1,
  `the pull request was opened (#${opened[1]})`,
);
// workspace_dir places worktrees directly under it, keyed by the branch
// dirname (slashes flattened).
const worktreePath = path.join(workspace, BRANCH.replaceAll("/", "-"));
assert(existsSync(worktreePath), `the worktree exists at ${worktreePath}`);

function addReviewComment(id, body) {
  mock.pr.comments.push({
    id,
    body,
    user: { login: "salim" },
    path: "README.md",
    line: 1,
    created_at: new Date().toISOString(),
  });
}

function approve() {
  mock.pr.reviews.push({
    id: mock.pr.reviews.length + 1,
    state: "APPROVED",
    body: "",
    user: { login: "salim" },
    submitted_at: new Date().toISOString(),
  });
}

const runStatus = () => api(`/api/runs/${trigger.runId}`);
const settled = (want) =>
  waitFor(async () => {
    const run = await runStatus();
    return run.status === want ? run : null;
  }, `run to be ${want}`);

if (mode === "answer" || mode === "stale-resume") {
  addReviewComment(900, "why not a set here?");
  await poke();
  const reply = await waitFor(
    () => writes((w) => w.url.includes("/comments/900/replies"))[0],
    "the threaded reply",
  );
  const expected =
    mode === "stale-resume"
      ? "ANSWERED-BY-FRESH-CONTEXT"
      : "ANSWERED-BY-RESUMED-BUILDER";
  assert(
    reply.body.body === expected,
    `the answer landed in thread 900 from the ${mode === "stale-resume" ? "fresh context" : "resumed builder"}`,
  );
  if (mode === "stale-resume") {
    assert(
      server.log.includes("resume failed — rebuilding context"),
      "the resume failure was what sent it down the fallback",
    );
  }
  // The viewer guard: jigs' own reply must not wake the loop back into it.
  mock.pr.comments.push({
    id: 901,
    in_reply_to_id: 900,
    body: reply.body.body,
    user: { login: "jigs-bot" },
    path: "README.md",
    line: 1,
    created_at: new Date().toISOString(),
  });
  await poke();
  await new Promise((r) => setTimeout(r, 2000));
  assert(
    writes((w) => w.url.includes("/replies")).length === 1,
    "our own reply did not wake the loop back into the thread",
  );
}

if (mode === "ci-escalation") {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    mock.pr.headSha = `head-${attempt}`;
    mock.pr.checkRuns = [
      {
        name: "test",
        status: "completed",
        conclusion: "failure",
        html_url: "http://ci.test/1",
      },
    ];
    await poke();
    if (attempt < 4) {
      await waitFor(
        () =>
          (server.log.match(/\[reviewLoop\] pushed /g) ?? []).length >=
          attempt + 1,
        `fix attempt ${attempt} to be pushed`,
      );
    }
  }
  const escalation = await waitFor(
    () => writes((w) => w.url.includes("/issues/"))[0],
    "the @-mention escalation",
  );
  assert(
    escalation.body.body.startsWith("@"),
    "the fourth consecutive red escalated as an @-mention",
  );
  assert(
    (server.log.match(/\[reviewLoop\] pushed /g) ?? []).length === 4,
    "exactly three fix attempts were pushed before the escalation",
  );
  assert(
    !server.log.includes("[needsHuman] posted"),
    "escalation never went through needsHuman",
  );
}

if (mode === "approve-merge" || mode === "ci-escalation") {
  mock.pr.checkRuns = [];
  approve();
  await poke();
  const final = await settled("completed");
  assert(
    final.returnValue.pr.number === mock.pr.number,
    "the run returned the pull request it opened",
  );
  assert(
    writes((w) => w.method === "PUT" && w.url.endsWith("/merge")).length === 1,
    "jigs squash-merged the pull request",
  );
  assert(!existsSync(worktreePath), "the worktree was removed");
  assert(
    git(checkout, "branch", "--list", BRANCH) === "",
    "the local branch was deleted",
  );
  assert(
    git(checkout, "ls-remote", "--heads", "origin", BRANCH) === "",
    "the remote branch was deleted",
  );
  const { worktrees } = await api("/api/runs");
  assert(
    !worktrees.some((row) => row.path === worktreePath),
    "the registry row is gone",
  );
}

if (mode === "close-unmerged") {
  mock.pr.state = "closed";
  mock.pr.merged = false;
  await poke();
  const final = await settled("failed");
  assert(
    String(final.error).includes("closed without merging"),
    "the run is terminal failed, naming the closed PR",
  );
  assert(!existsSync(worktreePath), "the worktree was removed");
  // The failed rows: the branch is the only cheap copy of unmerged work.
  assert(
    git(checkout, "branch", "--list", BRANCH) !== "",
    "the local branch survives as the insurance copy",
  );
  assert(
    git(checkout, "ls-remote", "--heads", "origin", BRANCH) !== "",
    "the remote branch survives too",
  );
  const { worktrees } = await api("/api/runs");
  assert(
    !worktrees.some((row) => row.path === worktreePath),
    "the registry row is gone",
  );
}

console.log(`\nPASS: ${mode}`);
server.child.kill("SIGKILL");
process.exit(0);
