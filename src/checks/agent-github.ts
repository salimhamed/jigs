import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GithubIdentity } from "../config/factory-config.ts";
import { resolveGithubIdentities } from "../providers/github-auth.ts";
import { factoryAgentEnv, harnessEnv } from "../steps/agents/harnesses/env.ts";
import type { Harness } from "../workflow/agents/harness-config.ts";
import { type Check, type CheckResult, PROBE_TIMEOUT_MS } from "./catalog.ts";
import { RESTART_SERVICE } from "./core.ts";

const execFileAsync = promisify(execFile);

export interface AgentGithubCheckDeps {
  identities?: () => GithubIdentity[];
  exec?: (
    file: string,
    args: string[],
    options: { env: Record<string, string>; timeout: number },
  ) => Promise<unknown>;
  factoryEnv?: () => readonly string[];
}

/** Whether a program answers `--version` under the environment an agent step gets. */
export function agentCommandCheck(
  id: string,
  label: string,
  command: string,
  repair: string,
  deps: AgentGithubCheckDeps = {},
): Check {
  return {
    id,
    label,
    run: async (): Promise<CheckResult> => {
      const exec = deps.exec ?? execFileAsync;
      try {
        const env = harnessEnv((deps.factoryEnv ?? factoryAgentEnv)());
        await exec(command, ["--version"], { env, timeout: PROBE_TIMEOUT_MS });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: `\`${command} --version\` failed: ${err instanceof Error ? err.message : String(err)}`,
          repair,
        };
      }
    },
  };
}

/**
 * What an agent whose harness sets `github` needs: a GitHub App identity to act as, and `gh`.
 * Nothing when no harness sets it.
 */
export function agentGithubChecks(
  agents: readonly Harness[],
  deps: AgentGithubCheckDeps = {},
): Check[] {
  if (!agents.some((agent) => agent.github !== undefined)) return [];
  return [
    {
      id: "github.agent-identity",
      label: "GitHub App for agents",
      run: async (): Promise<CheckResult> => {
        const identities = (deps.identities ?? resolveGithubIdentities)();
        if (identities.some((identity) => identity.mode === "app")) return { ok: true };
        return {
          ok: false,
          reason:
            "an agent's harness sets github, which needs a GitHub App identity, and this factory uses a personal access token",
          repair: `configure a GitHub App in github.identities in jigs.config.ts, or remove github from the harness and give the agent its own GitHub access, then: \`${RESTART_SERVICE}\``,
        };
      },
    },
    agentCommandCheck(
      "agent.gh",
      "GitHub CLI for agents",
      "gh",
      "install the GitHub CLI (https://cli.github.com), on the PATH the service starts agents with",
      deps,
    ),
  ];
}
