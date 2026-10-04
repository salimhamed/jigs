import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { scrubCredentials } from "../providers/git.ts";
import { checkWorktreeCodexMcpConfig } from "../steps/agents/harnesses/codex-config-guard.ts";
import {
  mcpCredentialProblem,
  type ResolvedMcpServer,
  resolveMcpServer,
} from "../steps/agents/harnesses/mcp-credentials.ts";
import type {
  McpServerConfig,
  McpToolProbe,
  PiMcpServerConfig,
} from "../workflow/agents/harness-config.ts";
import { CHECK_TIMEOUT_MS, type Check, type CheckResult, PROBE_TIMEOUT_MS } from "./catalog.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "./core.ts";

// A step runs these when its agent starts, and doctor runs them for the agents
// a workflow declares under `requires.agents`. Preflight does not: a step can
// build its servers inside the workflow body. An agent's self-enumeration is
// not evidence, hence the real tool call below.

const DECLARED_PER_STEP =
  "MCP servers are declared per step in the workflow body, never repo-owned";

const STDERR_TAIL_LINES = 5;
const STDERR_LINE_CHARS = 300;
const STDERR_SETTLE_MS = 1_000;
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH/i;

// Kept so a server that dies before connecting can say why. Draining it also
// stops a chatty server from blocking on a full pipe.
function stderrTail(transport: StdioClientTransport): () => Promise<string[]> {
  let lines: string[] = [];
  let partial = "";
  const stream = transport.stderr;
  stream?.on("data", (chunk: Buffer) => {
    const parts = (partial + chunk.toString("utf8")).split("\n");
    partial = (parts.pop() ?? "").slice(-65_536);
    lines = [...lines, ...parts].filter((line) => line.trim() !== "").slice(-STDERR_TAIL_LINES);
  });
  // A failed connect closes the server; its last words can trail the error.
  const ended = new Promise<void>((resolve) => stream?.once("end", resolve));
  return async () => {
    await Promise.race([ended, delay(STDERR_SETTLE_MS, undefined, { ref: false })]);
    return [...lines, partial]
      .filter((line) => line.trim() !== "")
      .slice(-STDERR_TAIL_LINES)
      .map((line) => line.trim());
  };
}

// Stderr can repeat what the server was handed: its declared credentials, any
// inherited variable named like one, and URLs with a password in them.
function redactor(
  declared: Record<string, string>,
  inherited: Record<string, string>,
): (text: string) => string {
  const secrets = [
    ...Object.values(declared),
    ...Object.entries(inherited)
      .filter(([name]) => SECRET_NAME.test(name))
      .map(([, value]) => value),
  ]
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length);
  return (text) =>
    scrubCredentials(secrets.reduce((out, secret) => out.replaceAll(secret, "[redacted]"), text));
}

type Connection = { transport: Transport; stderr: () => Promise<string> };

function transportFor(
  server: ResolvedMcpServer,
  cwd: string,
  inherited: Record<string, string>,
): Connection {
  if ("command" in server) {
    const transport = new StdioClientTransport({
      command: server.command,
      ...(server.args !== undefined ? { args: server.args } : {}),
      env: { ...inherited, ...server.env },
      // The step's worktree, so a server whose command or args resolve
      // relative to it is proven where it will run. Doctor has no worktree
      // and starts it from the factory root.
      cwd,
      stderr: "pipe",
    });
    const tail = stderrTail(transport);
    const redact = redactor(server.env ?? {}, inherited);
    return {
      transport,
      stderr: async () =>
        (await tail()).map((line) => redact(line).slice(0, STDERR_LINE_CHARS)).join(" | "),
    };
  }
  const headers = { ...server.headers };
  return {
    transport: new StreamableHTTPClientTransport(new URL(server.url), {
      ...(Object.keys(headers).length === 0 ? {} : { requestInit: { headers } }),
    }),
    stderr: async () => "",
  };
}

type ServerChecks = {
  /** Whether a stdio server inherits the step environment besides its declaration. */
  inherit: boolean;
};

export function mcpCredentialFailure(
  name: string,
  server: McpServerConfig,
  env: Record<string, string>,
): CheckResult | undefined {
  const problem = mcpCredentialProblem(name, server, env);
  if (problem === undefined) return undefined;
  const { reason, missing } = problem;
  return {
    ok: false,
    reason,
    repair:
      missing === undefined
        ? `fix the '${name}' server's credential names; each names a variable in ${SERVICE_ENV_FILE}\n${DECLARED_PER_STEP}`
        : `set ${missing} in ${SERVICE_ENV_FILE}, then: \`${RESTART_SERVICE}\``,
  };
}

async function checkMcpServer(
  name: string,
  server: McpServerConfig | PiMcpServerConfig,
  cwd: string,
  env: Record<string, string>,
  options: ServerChecks,
): Promise<CheckResult> {
  const credentials = mcpCredentialFailure(name, server, env);
  if (credentials !== undefined) return credentials;
  // Pi's pinned adapter owns OAuth refresh and secure-store access. A raw MCP
  // client cannot reproduce that flow without adding a second integration,
  // so OAuth servers are exercised by the Pi tool call itself.
  if ("auth" in server && server.auth === "oauth") return { ok: true };

  // Typed required, still guarded: this check is the last thing standing
  // between a JSON-shaped caller and an unproven server.
  const probe: McpToolProbe | undefined = server.probe;
  if (probe === undefined || probe.tool === "") {
    return {
      ok: false,
      reason: `MCP server '${name}' declares no probe tool, so its availability cannot be proven`,
      repair: `declare a probe on '${name}': probe: { tool: "<a tool the server exposes>" }\n${DECLARED_PER_STEP}`,
    };
  }

  const client = new Client({ name: "jigs", version: "0" });
  const { transport, stderr } = transportFor(
    resolveMcpServer(server, env),
    cwd,
    options.inherit ? env : {},
  );
  try {
    await client.connect(transport, { timeout: CHECK_TIMEOUT_MS });
  } catch (err) {
    const said = await stderr();
    return {
      ok: false,
      reason: `MCP server '${name}' did not start or connect: ${err}${said === "" ? "" : `; its stderr ended: ${said}`}`,
      repair: `fix the '${name}' server's command, url or credentials\n${DECLARED_PER_STEP}`,
    };
  }

  try {
    const { tools } = await client.listTools(undefined, {
      timeout: CHECK_TIMEOUT_MS,
    });
    const names = tools.map((tool) => tool.name);
    if (!names.includes(probe.tool)) {
      return {
        ok: false,
        reason: `MCP server '${name}' connected but exposes no tool '${probe.tool}' (it exposes: ${names.join(", ") || "nothing"})`,
        repair: `point '${name}''s probe at a tool it actually exposes\n${DECLARED_PER_STEP}`,
      };
    }
    const result = await client.callTool(
      { name: probe.tool, arguments: probe.arguments ?? {} },
      undefined,
      { timeout: CHECK_TIMEOUT_MS },
    );
    if (result.isError === true) {
      return {
        ok: false,
        reason: `MCP server '${name}' answered its probe tool '${probe.tool}' with an error: ${JSON.stringify(result.content)}`,
        repair: `check the '${name}' server's credentials and probe arguments\n${DECLARED_PER_STEP}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `MCP server '${name}' failed its probe tool call: ${err}`,
      repair: `check the '${name}' server's credentials and probe arguments\n${DECLARED_PER_STEP}`,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

// `env` is the step environment, which the named credentials resolve from. A
// Claude or Codex stdio server also inherits it; Pi's adapter starts each child
// from its declaration alone.
export function mcpServerChecks(
  servers: Record<string, McpServerConfig | PiMcpServerConfig>,
  cwd: string,
  env: Record<string, string>,
  options: ServerChecks,
): Check[] {
  return Object.entries(servers).map(([name, server]) => ({
    id: `mcp.${name}`,
    label: `MCP server ${name}`,
    run: () => checkMcpServer(name, server, cwd, env, options),
  }));
}

/**
 * Whether a hosted server answers at all. Any HTTP status counts: without the agent's token a
 * server is expected to refuse.
 */
export function mcpReachableCheck(
  id: string,
  label: string,
  url: string,
  doFetch: typeof fetch = fetch,
): Check {
  return {
    id,
    label,
    run: async (): Promise<CheckResult> => {
      try {
        const response = await doFetch(url, {
          method: "POST",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        await response.body?.cancel();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: `${url} did not answer: ${err instanceof Error ? err.message : String(err)}`,
          repair: `check the service's network access to ${new URL(url).host}, or the server's url`,
        };
      }
    },
  };
}

export function codexWorktreeConfigCheck(worktreeDir: string): Check {
  return {
    id: "mcp.codex-worktree-config",
    label: "worktree .codex/config.toml",
    run: async () => checkWorktreeCodexMcpConfig(worktreeDir),
  };
}
