// Shared harness for the acceptance repro scripts (crash-repro,
// suspension-repro): spawn the built server against the Postgres World,
// poll, assert. Each script stays standalone-runnable.
import { spawn } from "node:child_process";

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
