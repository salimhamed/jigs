import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import semver from "semver";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MIN_PI_VERSION, resolvePiExecutable } from "./executables.ts";
import { executePi } from "./pi.ts";
import { writePiMcpExtension } from "./pi-extension.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => removeTmpDir(tmp));

function hasSupportedPi(): boolean {
  try {
    const answer = spawnSync(resolvePiExecutable(process.env), ["--version"], { encoding: "utf8" });
    const version = semver.coerce(`${answer.stdout}${answer.stderr}`, { includePrerelease: true });
    return answer.status === 0 && version !== null && semver.gte(version, MIN_PI_VERSION);
  } catch {
    return false;
  }
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

function sse(
  response: import("node:http").ServerResponse,
  delta: Record<string, unknown>,
  finish: string | null,
) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    connection: "keep-alive",
    "cache-control": "no-cache",
  });
  response.write(
    `data: ${JSON.stringify({
      id: "scripted-response",
      object: "chat.completion.chunk",
      created: 1,
      model: "mcp-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeModelHome(port: number): { home: string; sessions: string } {
  const home = path.join(tmp, "pi-home");
  const sessions = path.join(tmp, "sessions");
  mkdirSync(home);
  mkdirSync(sessions);
  writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({
      packages: [],
      retry: { enabled: false },
      providerRetry: { maxRetries: 0, maxRetryDelayMs: 0 },
    }),
  );
  writeFileSync(
    path.join(home, "models.json"),
    JSON.stringify({
      providers: {
        scripted: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "offline-test",
          models: [
            {
              id: "mcp-model",
              name: "MCP model",
              contextWindow: 8192,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              compat: { supportsDeveloperRole: true },
            },
          ],
        },
      },
    }),
  );
  return { home, sessions };
}

function probeFixture(): string {
  return path.join(import.meta.dirname, "live", "fixtures", "mcp-probe-server.mjs");
}

function writeDecoyConfig(file: string, pidFile: string, name: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        [name]: {
          command: process.execPath,
          args: [probeFixture()],
          env: { PROBE_TOKEN: "DECOY", PROBE_PID_FILE: pidFile },
          lifecycle: "eager",
          directTools: true,
        },
      },
    }),
  );
}

function writeProbeExtension(home: string): string {
  return writePiMcpExtension(home, {
    allowed: {
      command: process.execPath,
      args: [probeFixture()],
      env: {
        PROBE_TOKEN: "JIGS_TEST_PROBE_TOKEN",
        PROBE_PID_FILE: "JIGS_TEST_PROBE_PID_FILE",
      },
      tools: ["get_probe_token"],
      probe: { tool: "get_probe_token" },
    },
  });
}

function piArgs(extension: string, sessions: string): string[] {
  return [
    "--mode",
    "json",
    "--model",
    "scripted/mcp-model",
    "--session-id",
    "mcp-offline",
    "--session-dir",
    sessions,
    "-ne",
    "-ns",
    "-np",
    "--no-themes",
    "-nc",
    "--no-approve",
    "-e",
    extension,
    "Call the available probe tool.",
  ];
}

function piEnv(home: string, token: string, pidFile: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: tmp,
    PI_CODING_AGENT_DIR: home,
    NO_PROXY: "127.0.0.1,localhost",
    JIGS_TEST_PROBE_TOKEN: token,
    JIGS_TEST_PROBE_PID_FILE: pidFile,
    UNRELATED_SECRET: "must-not-reach-mcp-child",
  };
}

test.skipIf(!hasSupportedPi())(
  "installed Pi exposes only the explicit MCP snapshot, calls its stdio tool, and cleans it up",
  async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        requests.push(parsed);
        if (requests.length === 1) {
          sse(
            response,
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "probe-call",
                  type: "function",
                  function: { name: "allowed_get_probe_token", arguments: "{}" },
                },
              ],
            },
            "tool_calls",
          );
          return;
        }
        sse(response, { role: "assistant", content: "probe complete" }, "stop");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing model port");
    const { home, sessions } = writeModelHome(address.port);
    const allowedPid = path.join(tmp, "allowed.pid");
    const projectDecoyPid = path.join(tmp, "project-decoy.pid");
    const globalDecoyPid = path.join(tmp, "global-decoy.pid");
    const piDecoyPid = path.join(tmp, "pi-decoy.pid");
    writeDecoyConfig(path.join(tmp, ".mcp.json"), projectDecoyPid, "project-decoy");
    writeDecoyConfig(path.join(tmp, ".config", "mcp", "mcp.json"), globalDecoyPid, "global-decoy");
    writeDecoyConfig(path.join(tmp, ".pi", "mcp.json"), piDecoyPid, "pi-decoy");
    const agentDirDecoyPid = path.join(tmp, "agent-dir-decoy.pid");
    const agentsDecoyPid = path.join(tmp, "agents-decoy.pid");
    writeDecoyConfig(path.join(home, "mcp.json"), agentDirDecoyPid, "agent-dir-decoy");
    writeDecoyConfig(path.join(tmp, ".agents", "mcp.json"), agentsDecoyPid, "agents-decoy");
    const extension = writeProbeExtension(home);

    try {
      const generation = await executePi({
        args: piArgs(extension, sessions),
        cwd: tmp,
        env: piEnv(home, "EXPLICIT-PROBE", allowedPid),
      });

      expect(generation.text).toBe("probe complete");
      expect(requests).toHaveLength(2);
      const firstRequest = requests[0];
      if (firstRequest === undefined) throw new Error("model received no request");
      const tools = (firstRequest.tools as Array<{ function?: { name?: string } }>).map(
        (tool) => tool.function?.name,
      );
      expect(tools).toContain("allowed_get_probe_token");
      expect(tools).not.toContain("mcp");
      expect(tools.some((name) => name?.startsWith("mcp__") ?? false)).toBe(false);
      expect(tools.some((name) => name?.includes("decoy") ?? false)).toBe(false);
      expect(JSON.stringify(requests[1])).toContain("EXPLICIT-PROBE");
      expect(JSON.stringify(requests[1])).toContain("UNRELATED=UNSET");
      expect(JSON.stringify(requests[1])).not.toContain("must-not-reach-mcp-child");
      expect(existsSync(projectDecoyPid)).toBe(false);
      expect(existsSync(globalDecoyPid)).toBe(false);
      expect(existsSync(piDecoyPid)).toBe(false);
      expect(existsSync(agentDirDecoyPid)).toBe(false);
      expect(existsSync(agentsDecoyPid)).toBe(false);
    } finally {
      await closeServer(server);
    }

    const pid = Number(readFileSync(allowedPid, "utf8"));
    await expect.poll(() => pidIsRunning(pid), { timeout: 2_000, interval: 25 }).toBe(false);
  },
  10_000,
);

test.skipIf(!hasSupportedPi())(
  "installed Pi hides the generic proxy when an explicit MCP server fails",
  async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body) as Record<string, unknown>);
        sse(response, { role: "assistant", content: "failure isolated" }, "stop");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing model port");
    const { home, sessions } = writeModelHome(address.port);
    const extension = writePiMcpExtension(home, {
      broken: {
        command: "definitely-not-an-mcp-server",
        tools: ["unreachable"],
        probe: { tool: "unreachable" },
      },
    });

    try {
      const generation = await executePi({
        args: piArgs(extension, sessions),
        cwd: tmp,
        env: piEnv(home, "UNUSED", path.join(tmp, "unused.pid")),
      });
      expect(generation.text).toBe("failure isolated");
      const firstRequest = requests[0];
      if (firstRequest === undefined) throw new Error("model received no request");
      const tools = (firstRequest.tools as Array<{ function?: { name?: string } }>).map(
        (tool) => tool.function?.name,
      );
      expect(tools).not.toContain("mcp");
      expect(tools).not.toContain("broken_unreachable");
    } finally {
      await closeServer(server);
    }
  },
  10_000,
);

test.skipIf(!hasSupportedPi())(
  "installed Pi shuts down its eager MCP child after model failure",
  async () => {
    const server = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "scripted failure" } }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing model port");
    const { home, sessions } = writeModelHome(address.port);
    const pidFile = path.join(tmp, "failed.pid");
    const extension = writeProbeExtension(home);

    try {
      await expect(
        executePi({
          args: piArgs(extension, sessions),
          cwd: tmp,
          env: piEnv(home, "FAILURE-PROBE", pidFile),
        }),
      ).rejects.toThrow("scripted failure");
    } finally {
      await closeServer(server);
    }

    const pid = Number(readFileSync(pidFile, "utf8"));
    await expect.poll(() => pidIsRunning(pid), { timeout: 2_000, interval: 25 }).toBe(false);
  },
  10_000,
);

test.skipIf(!hasSupportedPi())(
  "installed Pi shuts down its eager MCP child when the invocation is cancelled",
  async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing model port");
    const { home, sessions } = writeModelHome(address.port);
    const pidFile = path.join(tmp, "cancelled.pid");
    const extension = writeProbeExtension(home);
    const controller = new AbortController();
    const execution = executePi({
      args: piArgs(extension, sessions),
      cwd: tmp,
      env: piEnv(home, "CANCEL-PROBE", pidFile),
      signal: controller.signal,
    });

    try {
      await expect.poll(() => existsSync(pidFile), { timeout: 3_000, interval: 25 }).toBe(true);
      controller.abort(new Error("cancelled by jigs"));
      await expect(execution).rejects.toThrow("cancelled by jigs");
    } finally {
      controller.abort(new Error("test cleanup"));
      await closeServer(server);
    }

    const pid = Number(readFileSync(pidFile, "utf8"));
    await expect.poll(() => pidIsRunning(pid), { timeout: 2_000, interval: 25 }).toBe(false);
  },
  10_000,
);
