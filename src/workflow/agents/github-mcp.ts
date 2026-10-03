import { JigsError } from "../errors.ts";
import type {
  AgentGithub,
  McpServerConfig,
  McpStdioServerConfig,
  PiMcpServerConfig,
  PiMcpStdioServerConfig,
} from "./harness-config.ts";

/** The variable that holds the token of an agent whose harness sets `github`. */
export const AGENT_GITHUB_TOKEN_ENV = "GH_TOKEN";

// GitHub's default toolsets without `context`, whose tools need a user and
// fail for an installation token.
const TOOLSETS = "copilot,issues,pull_requests,repos,users";

const PROBE = {
  tool: "search_repositories",
  arguments: { query: "repo:github/github-mcp-server", perPage: 1 },
};

/**
 * Options for {@link githubMcp} on a Pi harness.
 *
 * @group Harnesses and models
 */
export type GithubMcpOptions = {
  /** Raw MCP tool names the model may call. jigs adds the probe tool, `search_repositories`. */
  tools: string[];
};

/**
 * An MCP server that gives an agent GitHub's own tools, acting as the factory's GitHub App.
 *
 * @remarks
 * It runs `github-mcp-server`, which must be installed on the machine, with the token of an
 * agent whose harness sets `github`; a harness without `github` cannot use it. Tools that need a
 * user, such as `get_me`, are left out, since an App's token cannot answer them. Pi needs the
 * list of tools the model may call.
 *
 * @example
 * ```ts
 * import { githubMcp, harnesses } from "@jigs-ai/jigs";
 *
 * const builder = harnesses.claude({
 *   model: "opus",
 *   github: true,
 *   mcpServers: { github: githubMcp() },
 * });
 * ```
 *
 * @group Harnesses and models
 */
export function githubMcp(): McpStdioServerConfig;
export function githubMcp(options: GithubMcpOptions): PiMcpStdioServerConfig;
export function githubMcp(
  options?: GithubMcpOptions,
): McpStdioServerConfig | PiMcpStdioServerConfig {
  const server = {
    command: "github-mcp-server",
    args: ["stdio", `--toolsets=${TOOLSETS}`],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: AGENT_GITHUB_TOKEN_ENV },
    probe: PROBE,
  };
  return options === undefined
    ? server
    : { ...server, tools: [...new Set([PROBE.tool, ...options.tools])] };
}

/** Whether a server is handed the token of an agent whose harness sets `github`. */
export function readsAgentGithubToken(server: McpServerConfig | PiMcpServerConfig): boolean {
  const sources =
    "command" in server
      ? Object.values(server.env ?? {})
      : [...Object.values(server.headers ?? {}), server.bearerTokenEnv];
  return sources.includes(AGENT_GITHUB_TOKEN_ENV);
}

/** Reject an MCP server that reads the agent's GitHub token on a harness that does not set `github`. */
export function assertGithubMcp(harness: {
  mcpServers?: Record<string, McpServerConfig | PiMcpServerConfig> | undefined;
  github?: AgentGithub | undefined;
}): void {
  if (harness.github !== undefined) return;
  const name = Object.entries(harness.mcpServers ?? {}).find(([, server]) =>
    readsAgentGithubToken(server),
  )?.[0];
  if (name !== undefined)
    throw new JigsError(
      `MCP server '${name}' reads ${AGENT_GITHUB_TOKEN_ENV}, the token jigs gives only to an agent whose harness sets github`,
      "set `github: true` on the harness, or `github: { owner }` for an agent with no worktree",
    );
}
