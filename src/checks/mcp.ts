import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { checkWorktreeCodexMcpConfig } from "../steps/agents/harnesses/codex-config-guard.ts";
import type { McpServerConfig, McpToolProbe } from "../workflow/agents/harness-config.ts";
import { CHECK_TIMEOUT_MS, type Check, type CheckResult } from "./catalog.ts";

// MCP checks are JIT-only by design: a step's servers are built inside the
// workflow body, so there is nothing to preflight — and an agent's
// self-enumeration is not evidence, hence the real tool call below.

const DECLARED_PER_STEP =
  "MCP servers are declared per step in the workflow body, never repo-owned";

function transportFor(
  server: McpServerConfig,
  cwd: string,
  env: Record<string, string>,
): Transport {
  if ("command" in server) {
    return new StdioClientTransport({
      command: server.command,
      ...(server.args !== undefined ? { args: server.args } : {}),
      env: { ...env, ...server.env },
      // The worktree, for the same reason: a server whose command or args
      // resolve relative to the working tree is otherwise proven somewhere it
      // will never run.
      cwd,
      stderr: "ignore",
    });
  }
  const headers = { ...server.headers };
  return new StreamableHTTPClientTransport(new URL(server.url), {
    ...(Object.keys(headers).length === 0 ? {} : { requestInit: { headers } }),
  });
}

async function checkMcpServer(
  name: string,
  server: McpServerConfig,
  cwd: string,
  env: Record<string, string>,
): Promise<CheckResult> {
  // Typed required, still guarded: this check is the last thing standing
  // between a JSON-shaped caller and an unproven server.
  const probe: McpToolProbe | undefined = server.probe;
  if (probe === undefined || probe.tool === "") {
    return {
      ok: false,
      reason: `MCP server '${name}' declares no probe tool, so its availability cannot be proven`,
      repair: `declare a probe on '${name}': probe: { tool: "<a tool the server exposes>" } — ${DECLARED_PER_STEP}`,
    };
  }

  const client = new Client({ name: "jigs", version: "0" });
  try {
    await client.connect(transportFor(server, cwd, env), {
      timeout: CHECK_TIMEOUT_MS,
    });
  } catch (err) {
    return {
      ok: false,
      reason: `MCP server '${name}' did not start or connect: ${err}`,
      repair: `fix the '${name}' server's command, url or credentials — ${DECLARED_PER_STEP}`,
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
        repair: `point '${name}''s probe at a tool it actually exposes — ${DECLARED_PER_STEP}`,
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
        repair: `check the '${name}' server's credentials and probe arguments — ${DECLARED_PER_STEP}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `MCP server '${name}' failed its probe tool call: ${err}`,
      repair: `check the '${name}' server's credentials and probe arguments — ${DECLARED_PER_STEP}`,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

// `env` is what the server inherits besides its own declaration: the step
// environment for Claude and Codex, nothing for Pi, whose adapter starts each
// child from its declaration.
export function mcpServerChecks(
  servers: Record<string, McpServerConfig>,
  cwd: string,
  env: Record<string, string> = {},
): Check[] {
  return Object.entries(servers).map(([name, server]) => ({
    id: `mcp.${name}`,
    label: `MCP server ${name}`,
    run: () => checkMcpServer(name, server, cwd, env),
  }));
}

export function codexWorktreeConfigCheck(worktreeDir: string): Check {
  return {
    id: "mcp.codex-worktree-config",
    label: "worktree .codex/config.toml",
    run: async () => checkWorktreeCodexMcpConfig(worktreeDir),
  };
}
