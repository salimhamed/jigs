import { AGENT_TOKEN_ENV } from "./agent-access.ts";
import type { McpStdioServerConfig, PiMcpStdioServerConfig } from "./harness-config.ts";

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
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: AGENT_TOKEN_ENV.github },
    probe: PROBE,
  };
  return options === undefined
    ? server
    : { ...server, tools: [...new Set([PROBE.tool, ...options.tools])] };
}
