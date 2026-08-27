// Shared harness for the acceptance repro scripts (crash-repro,
// suspension-repro): spawn the built server against the Postgres World,
// poll, assert. Each script stays standalone-runnable.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

export function assert(cond, message) {
  if (!cond) {
    console.error(`\nFAIL: ${message}`);
    process.exit(1);
  }
  console.log(`  ok: ${message}`);
}

export async function waitFor(fn, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const waitForLog = (server, regex, timeoutMs) =>
  waitFor(() => server.log.match(regex), regex, timeoutMs);

// Trigger-path preflight runs the core credential checks on every pipeline, so
// even a repro that needs neither provider must answer them — otherwise the
// trigger is refused, or the script makes live calls on every run.
export async function startProviderStub() {
  const server = createServer(async (req, res) => {
    const json = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/graphql") {
      for await (const _chunk of req);
      return json({ data: { viewer: { id: "bot-1", name: "jigs" } } });
    }
    if (req.method === "GET" && req.url === "/github/user") {
      return json({ login: "jigs-bot" });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  process.on("exit", () => server.close());
  const base = `http://localhost:${server.address().port}`;
  return {
    LINEAR_API_KEY: "mock-linear-key",
    GITHUB_TOKEN: "mock-github-token",
    LINEAR_API_URL: `${base}/graphql`,
    GITHUB_API_URL: `${base}/github`,
  };
}

// The fuller stub: an issue with a creator, a comment list the bot can post
// into, and a PR whose state the caller mutates through the returned `mock`.
// jit-repro, ticket-review-repro and review-loop-repro keep their own.
export async function startLinearGithubStub() {
  const mock = {
    creator: { id: "creator-1", name: "salim" },
    viewer: { id: "bot-1" },
    comments: [],
    createdComments: [],
    pr: {
      state: "open",
      merged: false,
      headSha: "head-1",
      reviews: [],
      comments: [],
      checkRuns: [],
    },
  };
  const server = createServer(async (req, res) => {
    const json = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/graphql") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { query, variables } = JSON.parse(raw);
      // Before the "comments" check: the mutation string contains it too.
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
        return json({
          data: { issue: { comments: { nodes: mock.comments } } },
        });
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
      if (req.url.includes("/check-runs")) {
        return json({ check_runs: mock.pr.checkRuns });
      }
      if (req.url.includes("/comments")) return json(mock.pr.comments);
      return json({
        state: mock.pr.state,
        merged: mock.pr.merged,
        head: { sha: mock.pr.headSha },
      });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  process.on("exit", () => server.close());
  const base = `http://localhost:${server.address().port}`;
  return {
    mock,
    env: {
      LINEAR_API_KEY: "mock-linear-key",
      GITHUB_TOKEN: "mock-github-token",
      LINEAR_API_URL: `${base}/graphql`,
      GITHUB_API_URL: `${base}/github`,
    },
  };
}

export function createHarness({ port, env: extraEnv = {} }) {
  const base = `http://localhost:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
    WORKFLOW_POSTGRES_URL:
      process.env.WORKFLOW_POSTGRES_URL ??
      "postgres://jigs:jigs@localhost:5439/jigs",
    ...extraEnv,
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

  const up = () =>
    fetch(`${base}/health`)
      .then((r) => r.ok)
      .catch(() => false);

  const healthy = () => waitFor(up, "/health");

  async function ensurePortFree() {
    if (await up()) {
      console.error(
        `FAIL: something already listens on ${base} — stop it first`,
      );
      process.exit(2);
    }
  }

  async function api(path, body) {
    const res = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  return { base, startServer, healthy, ensurePortFree, api };
}
