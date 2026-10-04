import { gitConfigEnv, githubAuthHeader, resolveRemoteUrl } from "../../../providers/git.ts";
import {
  type AppBot,
  appBotFor,
  type GithubAuth,
  githubAuthFor,
} from "../../../providers/github-auth.ts";
import { parseGithubRemote } from "../../../providers/github-remote.ts";
import { AGENT_TOKEN_ENV } from "../../../workflow/agents/agent-access.ts";
import type { Harness } from "../../../workflow/agents/harness-config.ts";
import { JigsError } from "../../../workflow/errors.ts";
import type { ResolvedAppIdentity } from "../../../workflow/factory-schema.ts";

// An agent's turn gets no refresh, so its token starts with close to the full hour.
export const AGENT_TOKEN_MIN_LIFETIME_MS = 55 * 60 * 1000;

/** Why an agent that sets `github` cannot run with a personal access token, and the way out. */
export const NEEDS_APP_IDENTITY = {
  reason:
    "an agent's harness sets github, which needs a GitHub App identity, and this factory uses a personal access token",
  repair:
    "configure a GitHub App in github.identities in jigs.config.ts, or remove github from the harness and give the agent its own GitHub access",
};

// `fatal` is what the SDK's FatalError.is reads: a retry reads the same configuration.
export class AgentGithubError extends JigsError {
  readonly fatal = true;
}

export interface AgentGithubDeps {
  remoteUrl(cwd: string): Promise<string>;
  auth(owner: string): GithubAuth;
  bot(identity: ResolvedAppIdentity, bearer: () => Promise<string>): Promise<AppBot>;
}

const defaultDeps: AgentGithubDeps = {
  remoteUrl: async (cwd) => (await resolveRemoteUrl(cwd)).url,
  auth: githubAuthFor,
  bot: appBotFor,
};

async function checkoutOwner(cwd: string, deps: AgentGithubDeps): Promise<string> {
  const url = await deps.remoteUrl(cwd);
  const ref = parseGithubRemote(url);
  if (ref === null)
    throw new AgentGithubError(
      `the agent's harness sets github: true, but ${cwd} is not a checkout of a github.com repository; name the account with github: { owner }`,
    );
  return ref.owner;
}

/**
 * What a harness that sets `github` adds to its agent's environment `env`: a fresh installation
 * token for `gh` and MCP servers, git settings that reach the owner's repositories over HTTPS
 * with it, and the App's bot as commit author. Nothing for a harness that does not set it.
 */
export async function agentGithubEnv(
  target: { harness: Harness; cwd: string },
  env: Record<string, string> = {},
  deps: AgentGithubDeps = defaultDeps,
): Promise<Record<string, string>> {
  const { harness, cwd } = target;
  if (harness.github === undefined) return {};
  const owner = harness.github === true ? await checkoutOwner(cwd, deps) : harness.github.owner;
  const auth = deps.auth(owner);
  if (auth.identity.mode === "pat")
    throw new AgentGithubError(`${NEEDS_APP_IDENTITY.reason}; ${NEEDS_APP_IDENTITY.repair}`);
  const token = await auth.bearer(AGENT_TOKEN_MIN_LIFETIME_MS);
  const bot = await deps.bot(auth.identity, () => auth.bearer());
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
