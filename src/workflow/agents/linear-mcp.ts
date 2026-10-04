import { AGENT_TOKEN_ENV } from "./agent-access.ts";
import type { McpHttpServerConfig, PiMcpHttpServerConfig } from "./harness-config.ts";

const PROBE = { tool: "list_teams", arguments: { limit: 1 } };

/**
 * Options for {@link linearMcp} on a Pi harness.
 *
 * @group Harnesses and models
 */
export type LinearMcpOptions = {
  /** Raw MCP tool names the model may call. jigs adds the probe tool, `list_teams`. */
  tools: string[];
};

/**
 * An MCP server that gives an agent Linear's own tools, acting as the factory on Linear.
 *
 * @remarks
 * It reaches Linear's hosted server at `https://mcp.linear.app/mcp` with the token of an agent
 * whose harness sets `linear`; a harness without `linear` cannot use it. In app mode the agent
 * acts as the factory's Linear app, in key mode as the API key's user. Pi needs the list of
 * tools the model may call. The result is plain data, so spread it to change a field, such as
 * `url` to `https://mcp.linear.app/mcp/readonly` for read tools only.
 *
 * @example
 * ```ts
 * import { harnesses, linearMcp } from "@jigs-ai/jigs";
 *
 * const triager = harnesses.claude({
 *   model: "opus",
 *   linear: true,
 *   mcpServers: { linear: linearMcp() },
 * });
 * ```
 *
 * @group Harnesses and models
 */
export function linearMcp(): McpHttpServerConfig;
export function linearMcp(options: LinearMcpOptions): PiMcpHttpServerConfig;
export function linearMcp(options?: LinearMcpOptions): McpHttpServerConfig | PiMcpHttpServerConfig {
  const server = {
    url: "https://mcp.linear.app/mcp",
    bearerTokenEnv: AGENT_TOKEN_ENV.linear,
    probe: PROBE,
  };
  return options === undefined
    ? server
    : { ...server, tools: [...new Set([PROBE.tool, ...options.tools])] };
}
