import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FatalError } from "workflow";
import { harnesses, models } from "../../../workflow/agents/harness-config.ts";
import { buildAgentRequest } from "../../../workflow/agents/plan.ts";
import { type DriverResolver, driverFor } from "../drivers/index.ts";
import { createPiDriver } from "../drivers/pi.ts";
import { executeAgentWith } from "../execute-agent.ts";
import { RunCancelledError } from "../run-cancellation.ts";
import { executionSeams } from "../seams.ts";
import { executePi } from "./pi.ts";
import { preparePiInvocationHome } from "./pi-home.ts";
import {
  cancellableRun,
  makeTmpDir,
  removeTmpDir,
  skipWithoutSupportedPi,
} from "./test-fixtures.ts";

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

const skipPi = skipWithoutSupportedPi();

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.skipIf(skipPi)(
  "cancelling the run stops installed Pi and its eager MCP child before the step settles",
  async () => {
    const pidFile = path.join(tmp, "mcp.pid");
    vi.stubEnv("JIGS_TEST_PROBE_PID_FILE", pidFile);
    vi.stubEnv("JIGS_TEST_PROBE_VALUE", "CANCEL-PROBE");
    vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
    vi.stubEnv("NO_PROXY", "127.0.0.1,localhost");
    let chatRequests = 0;
    // Lists its model for the request check, then never answers a turn.
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "hanging-model" }] }));
        return;
      }
      chatRequests += 1;
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing model port");

    const harness = harnesses.pi(
      models.openaiCompatible({
        name: "scripted",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "hanging-model",
      }),
      {
        mcpServers: {
          probe: {
            command: process.execPath,
            args: [path.join(import.meta.dirname, "live", "fixtures", "mcp-probe-server.mjs")],
            env: {
              PROBE_TOKEN: "JIGS_TEST_PROBE_VALUE",
              PROBE_PID_FILE: "JIGS_TEST_PROBE_PID_FILE",
            },
            tools: ["get_probe_token"],
            probe: { tool: "get_probe_token" },
          },
        },
      },
    );
    const worktree = path.join(tmp, "worktree");
    mkdirSync(worktree);
    const piHomes = path.join(tmp, "pi-homes");
    const pi = createPiDriver({
      openStepStream: () => undefined,
      preparePiHome: async (runId, plan) =>
        preparePiInvocationHome(runId, plan, { baseDir: piHomes }),
      executePi,
    });
    const run = cancellableRun();
    const step = executeAgentWith(
      buildAgentRequest({ harness, cwd: worktree, prompt: "Call the probe tool." }),
      { workflowRunId: "pi-cancel-offline" },
      {
        ...executionSeams,
        runStatus: run,
        factoryEnv: () => [],
        jitFailures: async () => undefined,
        resolveDriver: ((kind) => (kind === "pi" ? pi : driverFor(kind))) as DriverResolver,
      },
    );
    const settled = expect(step).rejects.toSatisfy(
      (error) => error instanceof RunCancelledError && FatalError.is(error),
    );

    try {
      await expect.poll(() => existsSync(pidFile), { timeout: 10_000, interval: 25 }).toBe(true);
      await expect.poll(() => chatRequests, { timeout: 10_000, interval: 25 }).toBeGreaterThan(0);
      const mcpChild = Number(readFileSync(pidFile, "utf8"));
      expect(pidIsRunning(mcpChild)).toBe(true);
      const cancelledAt = Date.now();

      run.cancel();
      await settled;

      expect(Date.now() - cancelledAt).toBeLessThan(5_000);
      expect(pidIsRunning(mcpChild)).toBe(false);
    } finally {
      run.cancel();
      await closeServer(server);
    }
  },
  30_000,
);
