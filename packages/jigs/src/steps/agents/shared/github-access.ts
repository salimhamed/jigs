import { AGENT_TOKEN_MIN_LIFETIME_MS } from "../../../providers/credentials.ts";
import { gitConfigEnv, githubAuthHeader } from "../../../providers/git.ts";
import { type GithubAuth, githubAuthFor } from "../../../providers/github-auth.ts";
import { AGENT_TOKEN_ENV } from "../../../workflow/agents/agent-access.ts";
import type { Harness } from "../../../workflow/agents/harness-config.ts";

export interface AgentGithubDeps {
  auth(installationName: string): GithubAuth;
}

const defaultDeps: AgentGithubDeps = {
  auth: (installationName) => githubAuthFor(installationName),
};

/**
 * What a harness that sets `github` adds to its agent's environment `env`: a fresh installation
 * token for `gh` and MCP servers, git settings that reach the installation account's repositories over HTTPS
 * with it, and the App's bot as commit author. Nothing for a harness that does not set it.
 */
export async function agentGithubEnv(
  harness: Harness,
  env: Record<string, string> = {},
  deps: AgentGithubDeps = defaultDeps,
): Promise<Record<string, string>> {
  if (harness.github === undefined) return {};
  const auth = deps.auth(harness.github.installationName);
  const token = await auth.bearer(AGENT_TOKEN_MIN_LIFETIME_MS.github);
  const [bot, owner] = await Promise.all([auth.bot(), auth.account()]);
  // An App cannot push over SSH. Only the owner's repositories move to HTTPS:
  // the token cannot reach anyone else's, such as an SSH dependency.
  const https = `url.https://github.com/${owner}/.insteadOf`;
  return {
    [AGENT_TOKEN_ENV.github]: token,
    ...gitConfigEnv(
      [
        [https, `git@github.com:${owner}/`],
        [https, `ssh://git@github.com/${owner}/`],
        githubAuthHeader(token, owner),
      ],
      env,
    ),
    // The committer and any signature stay the operator's own git configuration.
    GIT_AUTHOR_NAME: bot.login,
    GIT_AUTHOR_EMAIL: `${bot.id}+${bot.login}@users.noreply.github.com`,
  };
}
