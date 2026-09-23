import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harnesses, models } from "../../../blocks/agents/harness-config.ts";
import { buildAgentRequest } from "../../../blocks/agents/plan.ts";
import { type DriverResolver, driverFor } from "../drivers/index.ts";
import { createPiDriver } from "../drivers/pi.ts";
import { defaultAgentExecutionDependencies, executeAgent } from "../execute-agent.ts";
import { scrubbedEnv } from "./env.ts";
import { executePi } from "./pi.ts";
import { piMcpToolNames } from "./pi-extension.ts";
import { piRunStatePath, preparePiInvocationHome } from "./pi-home.ts";
import { makeTmpDir, removeTmpDir, skipWithoutSupportedPi } from "./test-fixtures.ts";

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

function sse(response: ServerResponse, delta: Record<string, unknown>, finish: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(
    `data: ${JSON.stringify({
      id: "scripted-response",
      object: "chat.completion.chunk",
      created: 1,
      model: "env-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((name) => path.join(dir, name))
    .filter((file) => statSync(file).isFile());
}

type EnvReport = {
  ppid: number;
  env: Record<string, string>;
  parentEnv: Record<string, string> | null;
};

// The MCP SDK's stdio transport always passes these through to a child.
const STDIO_DEFAULTS = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

test.skipIf(skipPi || process.platform !== "linux")(
  "installed Pi launches without credential-shaped names except the allowlisted ones, and its MCP child with only declared env",
  async () => {
    const id = crypto.randomUUID();
    const secrets = {
      SYNTHETIC_MODEL_API_KEY: `fake-model-key-${id}`,
      SYNTHETIC_MCP_TOKEN: `fake-mcp-token-${id}`,
      SYNTHETIC_UNRELATED_SECRET: `fake-unrelated-${id}`,
      SYNTHETIC_API_KEY: `fake-api-key-${id}`,
      SYNTHETIC_TOKEN: `fake-token-${id}`,
      OPENROUTER_API_KEY: `fake-openrouter-${id}`,
    };
    for (const [name, value] of Object.entries(secrets)) vi.stubEnv(name, value);
    // Removal is by name, so a secret under an ordinary name is inherited.
    vi.stubEnv("SYNTHETIC_PLAIN_VALUE", `plain-${id}`);
    const envFile = path.join(tmp, "mcp-env.jsonl");
    vi.stubEnv("JIGS_TEST_ENV_FILE", envFile);
    vi.stubEnv("JIGS_TEST_PROBE_VALUE", "ENV-PROBE");
    vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
    vi.stubEnv("NO_PROXY", "127.0.0.1,localhost");

    const authorizations: Array<string | undefined> = [];
    let chatRequests = 0;
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "env-model" }] }));
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        if (body === "") {
          console.warn(`scripted model ignored an empty ${request.method} ${request.url}`);
          response.end();
          return;
        }
        authorizations.push(request.headers.authorization);
        chatRequests += 1;
        if (chatRequests === 1) {
          sse(
            response,
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "env-call",
                  type: "function",
                  function: { name: toolName, arguments: "{}" },
                },
              ],
            },
            "tool_calls",
          );
          return;
        }
        sse(response, { role: "assistant", content: "env checked" }, "stop");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing model port");

    const mcpServers = {
      envprobe: {
        command: process.execPath,
        args: [path.join(import.meta.dirname, "live", "fixtures", "mcp-probe-server.mjs")],
        env: {
          PROBE_TOKEN: "JIGS_TEST_PROBE_VALUE",
          PROBE_ENV_FILE: "JIGS_TEST_ENV_FILE",
          MCP_API_TOKEN: "SYNTHETIC_MCP_TOKEN",
        },
        tools: ["get_probe_token"],
        probe: { tool: "get_probe_token" },
      },
    };
    const toolName = piMcpToolNames(mcpServers)[0] as string;
    const harness = harnesses.pi(
      models.openaiCompatible({
        name: "scripted",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "env-model",
        apiKeyEnv: "SYNTHETIC_MODEL_API_KEY",
      }),
      { mcpServers },
    );
    const worktree = path.join(tmp, "worktree");
    mkdirSync(worktree);
    const wire = buildAgentRequest({ harness, cwd: worktree, prompt: "Call the probe tool." });

    const piHomes = path.join(tmp, "pi-homes");
    const invocationFiles: Array<{ file: string; content: string }> = [];
    const pi = createPiDriver({
      preparePiHome: (runId, plan) => {
        const prepared = preparePiInvocationHome(runId, plan, { baseDir: piHomes });
        return {
          ...prepared,
          cleanup: () => {
            for (const file of filesUnder(prepared.home))
              invocationFiles.push({ file, content: readFileSync(file, "utf8") });
            prepared.cleanup();
          },
        };
      },
      executePi,
    });
    const runId = `pi-launch-env-${id}`;
    const allowlist = pi.envAllowlist(wire);
    const expectedPiEnv = scrubbedEnv(allowlist);

    let result: Awaited<ReturnType<typeof executeAgent>>;
    try {
      result = await executeAgent(
        wire,
        { workflowRunId: runId },
        {
          ...defaultAgentExecutionDependencies,
          resolveDriver: ((kind) => (kind === "pi" ? pi : driverFor(kind))) as DriverResolver,
        },
      );
    } finally {
      await closeServer(server);
    }

    expect(result).toMatchObject({ text: "env checked" });
    expect(authorizations).toEqual([
      `Bearer ${secrets.SYNTHETIC_MODEL_API_KEY}`,
      `Bearer ${secrets.SYNTHETIC_MODEL_API_KEY}`,
    ]);

    const reports = readFileSync(envFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as EnvReport);
    // jigs' own pre-launch probe starts the server once; Pi's adapter starts
    // it at least once more.
    const adapterStarts = reports.filter((report) => report.ppid !== process.pid);
    expect(reports.length - adapterStarts.length).toBe(1);
    expect(adapterStarts.length).toBeGreaterThan(0);
    for (const { env } of reports) {
      expect(Object.keys(env).sort()).toEqual(
        [
          "MCP_API_TOKEN",
          "PROBE_ENV_FILE",
          "PROBE_TOKEN",
          ...STDIO_DEFAULTS.filter((name) => process.env[name] !== undefined),
        ].sort(),
      );
      expect(env.MCP_API_TOKEN).toBe(secrets.SYNTHETIC_MCP_TOKEN);
      expect(env.PROBE_TOKEN).toBe("ENV-PROBE");
    }

    expect(new Set(adapterStarts.map((report) => report.ppid)).size).toBe(1);
    const piEnv = adapterStarts[0]?.parentEnv;
    if (piEnv === null || piEnv === undefined)
      throw new Error("Pi's launch environment was unread");
    const { PI_CODING_AGENT_DIR: agentDir, ...inherited } = piEnv;
    expect(agentDir?.startsWith(piRunStatePath(runId, { baseDir: piHomes }))).toBe(true);
    // Compared by name so a failure never prints the host's values. The
    // launcher may add its own non-credential variables, such as NODE_PATH.
    expect(Object.keys(expectedPiEnv).filter((name) => !(name in inherited))).toEqual([]);
    expect(allowlist).toEqual(
      expect.arrayContaining(["SYNTHETIC_MODEL_API_KEY", "SYNTHETIC_MCP_TOKEN"]),
    );
    expect(piEnv.SYNTHETIC_MODEL_API_KEY).toBe(secrets.SYNTHETIC_MODEL_API_KEY);
    expect(piEnv.SYNTHETIC_MCP_TOKEN).toBe(secrets.SYNTHETIC_MCP_TOKEN);
    for (const name of [
      "SYNTHETIC_UNRELATED_SECRET",
      "SYNTHETIC_API_KEY",
      "SYNTHETIC_TOKEN",
      "OPENROUTER_API_KEY",
    ])
      expect(name in piEnv, `${name} reached Pi`).toBe(false);
    expect(piEnv.SYNTHETIC_PLAIN_VALUE).toBe(`plain-${id}`);

    const written = [
      ...invocationFiles,
      ...filesUnder(piHomes).map((file) => ({ file, content: readFileSync(file, "utf8") })),
    ];
    expect(written.some(({ file }) => file.endsWith("mcp-adapter.ts"))).toBe(true);
    expect(written.some(({ file }) => file.endsWith("models.json"))).toBe(true);
    expect(written.some(({ file }) => file.endsWith(".jsonl"))).toBe(true);
    for (const { file, content } of written)
      for (const value of Object.values(secrets))
        expect(content.includes(value), `${file} contains a synthetic secret`).toBe(false);
  },
  15_000,
);
