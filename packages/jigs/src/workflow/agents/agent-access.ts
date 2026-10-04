import { JigsError } from "../errors.ts";
import type { McpServerConfig, PiMcpServerConfig } from "./harness-config.ts";

/** The variable holding the token jigs gives an agent whose harness opts in to each provider. */
export const AGENT_TOKEN_ENV = {
  github: "GH_TOKEN",
  linear: "JIGS_LINEAR_TOKEN",
  pagerduty: "JIGS_PAGERDUTY_TOKEN",
} as const;

/** A provider a harness can opt in to acting on as the factory. */
export type AgentAccessProvider = keyof typeof AGENT_TOKEN_ENV;

export const AGENT_ACCESS_PROVIDERS = Object.keys(AGENT_TOKEN_ENV) as AgentAccessProvider[];

/** The providers whose agent token a server is handed. */
export function agentTokensReadBy(
  server: McpServerConfig | PiMcpServerConfig,
): AgentAccessProvider[] {
  const sources: (string | undefined)[] =
    "command" in server
      ? Object.values(server.env ?? {})
      : [...Object.values(server.headers ?? {}), server.bearerTokenEnv];
  return AGENT_ACCESS_PROVIDERS.filter((provider) => sources.includes(AGENT_TOKEN_ENV[provider]));
}

/** Reject an MCP server that reads an agent token its harness has not opted in to. */
export function assertAgentAccess(
  harness: {
    mcpServers?: Record<string, McpServerConfig | PiMcpServerConfig> | undefined;
  } & { [P in AgentAccessProvider]?: unknown },
): void {
  for (const [name, server] of Object.entries(harness.mcpServers ?? {})) {
    const provider = agentTokensReadBy(server).find((p) => harness[p] === undefined);
    if (provider !== undefined)
      throw new JigsError(
        `MCP server '${name}' reads ${AGENT_TOKEN_ENV[provider]}, the token jigs gives only to an agent whose harness sets ${provider}`,
        `set \`${provider}: true\` on the harness${provider === "github" ? ", or `github: { owner }` for an agent with no worktree" : ""}`,
      );
  }
}
