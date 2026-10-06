import { AGENT_TOKEN_MIN_LIFETIME_MS } from "../../../providers/credentials.ts";
import { installationTokens } from "../../../providers/installation-tokens.ts";
import { AGENT_TOKEN_ENV, assertAgentAccess } from "../../../workflow/agents/agent-access.ts";
import type { Harness } from "../../../workflow/agents/harness-config.ts";
import { agentGithubEnv } from "./github-access.ts";

export interface AgentAccessDeps {
  github(harness: Harness, env: Record<string, string>): Promise<Record<string, string>>;
  token(provider: "linear" | "pagerduty", installationName: string): Promise<string>;
}

const defaultDeps: AgentAccessDeps = {
  github: (harness, env) => agentGithubEnv(harness, env),
  token: (provider, installationName) =>
    installationTokens(provider, installationName).bearer(AGENT_TOKEN_MIN_LIFETIME_MS[provider]),
};

/**
 * What the providers a harness opts in to add to its agent's environment `env`: GitHub's token
 * and git settings, and Linear and PagerDuty tokens, each from the installation the harness
 * names. Nothing for a harness that opts in to none.
 */
export async function agentAccessEnv(
  target: { harness: Harness; cwd: string },
  env: Record<string, string> = {},
  deps: AgentAccessDeps = defaultDeps,
): Promise<Record<string, string>> {
  const { harness } = target;
  assertAgentAccess(harness);
  const { linear, pagerduty } = harness;
  return {
    ...(await deps.github(harness, env)),
    ...(linear === undefined
      ? {}
      : { [AGENT_TOKEN_ENV.linear]: await deps.token("linear", linear.installationName) }),
    ...(pagerduty === undefined
      ? {}
      : { [AGENT_TOKEN_ENV.pagerduty]: await deps.token("pagerduty", pagerduty.installationName) }),
  };
}
