import { linearAuthFor } from "../../../providers/linear-auth.ts";
import { pagerDutyAuthFor } from "../../../providers/pagerduty-auth.ts";
import { AGENT_TOKEN_ENV, assertAgentAccess } from "../../../workflow/agents/agent-access.ts";
import type { Harness } from "../../../workflow/agents/harness-config.ts";
import { agentGithubEnv } from "./github-access.ts";

// Margin for a long agent turn, since its token is not refreshed during one.
export const PROVIDER_AGENT_TOKEN_MIN_LIFETIME_MS = 5 * 60 * 60 * 1000;

export interface AgentAccessDeps {
  github(
    target: { harness: Harness; cwd: string },
    env: Record<string, string>,
  ): Promise<Record<string, string>>;
  linearToken(): Promise<string>;
  pagerdutyToken(): Promise<string>;
}

const defaultDeps: AgentAccessDeps = {
  github: (target, env) => agentGithubEnv(target, env),
  linearToken: () => linearAuthFor().token(PROVIDER_AGENT_TOKEN_MIN_LIFETIME_MS),
  pagerdutyToken: () => pagerDutyAuthFor().bearer(PROVIDER_AGENT_TOKEN_MIN_LIFETIME_MS),
};

/**
 * What the providers a harness opts in to add to its agent's environment `env`: GitHub's token
 * and git settings, and the factory's Linear and PagerDuty tokens. Nothing for a harness that
 * opts in to none.
 */
export async function agentAccessEnv(
  target: { harness: Harness; cwd: string },
  env: Record<string, string> = {},
  deps: AgentAccessDeps = defaultDeps,
): Promise<Record<string, string>> {
  const { harness } = target;
  assertAgentAccess(harness);
  return {
    ...(await deps.github(target, env)),
    ...(harness.linear === undefined ? {} : { [AGENT_TOKEN_ENV.linear]: await deps.linearToken() }),
    ...(harness.pagerduty === undefined
      ? {}
      : { [AGENT_TOKEN_ENV.pagerduty]: await deps.pagerdutyToken() }),
  };
}
