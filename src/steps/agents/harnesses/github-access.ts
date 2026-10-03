import type { ResolvedAppIdentity } from "../../../config/factory-config.ts";
import { gitConfigEnv, githubAuthHeader, resolveRemoteUrl } from "../../../providers/git.ts";
import {
  AGENT_TOKEN_MIN_LIFETIME_MS,
  type AppBot,
  appBotFor,
  type GithubAuth,
  githubAuthFor,
} from "../../../providers/github-auth.ts";
import { parseGithubRemote } from "../../../providers/github-webhook.ts";
import { AGENT_GITHUB_TOKEN_ENV, assertGithubMcp } from "../../../workflow/agents/github-mcp.ts";
import type { Harness } from "../../../workflow/agents/harness-config.ts";
import { JigsError } from "../../../workflow/errors.ts";

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
 * What a harness that sets `github` adds to its agent's environment: a fresh installation token
 * for `gh` and MCP servers, git settings that push to github.com over HTTPS with it, and the
 * App's bot as commit author. Nothing for a harness that does not set it.
 */
export async function agentGithubEnv(
  target: { harness: Harness; cwd: string },
  deps: AgentGithubDeps = defaultDeps,
): Promise<Record<string, string>> {
  const { harness, cwd } = target;
  assertGithubMcp(harness);
  if (harness.github === undefined) return {};
  const owner = harness.github === true ? await checkoutOwner(cwd, deps) : harness.github.owner;
  const auth = deps.auth(owner);
  if (auth.identity.mode === "pat")
    throw new AgentGithubError(
      "the agent's harness sets github, which needs a GitHub App identity, and this factory uses a personal access token; configure a GitHub App in github.identities in jigs.config.ts, or remove github from the harness and give the agent its own GitHub access",
    );
  const token = await auth.bearer(AGENT_TOKEN_MIN_LIFETIME_MS);
  const bot = await deps.bot(auth.identity, () => auth.bearer());
  return {
    [AGENT_GITHUB_TOKEN_ENV]: token,
    // An App cannot push over SSH, and the worktree's remote is an SSH URL.
    ...gitConfigEnv([
      ["url.https://github.com/.insteadOf", "git@github.com:"],
      ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
      githubAuthHeader(token),
    ]),
    // The committer and any signature stay the operator's own git configuration.
    GIT_AUTHOR_NAME: bot.login,
    GIT_AUTHOR_EMAIL: `${bot.id}+${bot.login}@users.noreply.github.com`,
  };
}
