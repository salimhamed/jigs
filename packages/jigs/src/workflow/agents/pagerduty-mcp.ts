import { AGENT_TOKEN_ENV } from "./agent-access.ts";
import type { McpHttpServerConfig, PiMcpHttpServerConfig } from "./harness-config.ts";

const SERVER_URL = "https://mcp.pagerduty.com/mcp";

const PROBE = { tool: "list_incidents", arguments: { limit: 1 } };

// It answers for the token's user, and the factory's token belongs to an app.
const USER_TOOLS = ["get_user_data"];

/**
 * Options for {@link pagerdutyMcp} on a Pi harness.
 *
 * @group Harnesses and models
 */
export type PagerdutyMcpOptions = {
  /** Raw MCP tool names the model may call. jigs adds the probe tool, `list_incidents`. */
  tools: string[];
};

/**
 * An MCP server that gives an agent PagerDuty's own tools, acting as the factory's PagerDuty app.
 *
 * @remarks
 * It reaches PagerDuty's hosted server with the token of an agent whose harness sets
 * `pagerduty`; a harness without `pagerduty` cannot use it. The token carries the scopes jigs
 * itself uses, so the agent can read and update incidents and read users; other tools fail for
 * lack of a scope. The token belongs to an app, not a user, so `get_user_data` is disabled and
 * `list_incidents` cannot filter by the `assigned` or `teams` request scope. Pi needs the list of
 * tools the model may call; leave `get_user_data` out of it. The result is plain data: for an
 * account in the EU service region, spread it with `url: "https://mcp.eu.pagerduty.com/mcp"`.
 *
 * @example
 * ```ts
 * import { harnesses, pagerdutyMcp } from "@jigs-ai/jigs";
 *
 * const triager = harnesses.claude({
 *   model: "opus",
 *   pagerduty: true,
 *   mcpServers: { pagerduty: pagerdutyMcp() },
 * });
 * ```
 *
 * @group Harnesses and models
 */
export function pagerdutyMcp(): McpHttpServerConfig;
export function pagerdutyMcp(options: PagerdutyMcpOptions): PiMcpHttpServerConfig;
export function pagerdutyMcp(
  options?: PagerdutyMcpOptions,
): McpHttpServerConfig | PiMcpHttpServerConfig {
  const server = { url: SERVER_URL, bearerTokenEnv: AGENT_TOKEN_ENV.pagerduty, probe: PROBE };
  return options === undefined
    ? { ...server, disabledTools: USER_TOOLS }
    : { ...server, tools: [...new Set([PROBE.tool, ...options.tools])] };
}
