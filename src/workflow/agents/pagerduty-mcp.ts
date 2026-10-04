import { AGENT_TOKEN_ENV } from "./agent-access.ts";
import type { McpHttpServerConfig, PiMcpHttpServerConfig } from "./harness-config.ts";

const URLS = {
  us: "https://mcp.pagerduty.com/mcp",
  eu: "https://mcp.eu.pagerduty.com/mcp",
} as const;

const PROBE = { tool: "list_incidents", arguments: { limit: 1 } };

/**
 * Options for {@link pagerdutyMcp}.
 *
 * @group Harnesses and models
 */
export type PagerdutyMcpOptions = {
  /** The service region of the factory's PagerDuty account, as in its identity. Defaults to `us`. */
  region?: "us" | "eu";
};

/**
 * Options for {@link pagerdutyMcp} on a Pi harness.
 *
 * @group Harnesses and models
 */
export type PiPagerdutyMcpOptions = PagerdutyMcpOptions & {
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
 * lack of a scope. The token belongs to an app, not a user, so tools about the current user,
 * such as `get_user_data`, fail too: the hosted server cannot hide them. Pi needs the list of
 * tools the model may call.
 *
 * @example
 * ```ts
 * import { harnesses, pagerdutyMcp } from "@jigs-ai/jigs";
 *
 * const triager = harnesses.claude({
 *   model: "opus",
 *   pagerduty: true,
 *   mcpServers: { pagerduty: pagerdutyMcp({ region: "eu" }) },
 * });
 * ```
 *
 * @group Harnesses and models
 */
export function pagerdutyMcp(options?: PagerdutyMcpOptions): McpHttpServerConfig;
export function pagerdutyMcp(options: PiPagerdutyMcpOptions): PiMcpHttpServerConfig;
export function pagerdutyMcp(
  options: PagerdutyMcpOptions & { tools?: string[] } = {},
): McpHttpServerConfig | PiMcpHttpServerConfig {
  const server = {
    url: URLS[options.region ?? "us"],
    bearerTokenEnv: AGENT_TOKEN_ENV.pagerduty,
    probe: PROBE,
  };
  return options.tools === undefined
    ? server
    : { ...server, tools: [...new Set([PROBE.tool, ...options.tools])] };
}
