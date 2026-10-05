import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { factoryAgentEnv, harnessEnv } from "../steps/agents/shared/env.ts";
import type { Harness } from "../workflow/agents/harness-config.ts";
import { PROBE_TIMEOUT_MS } from "./catalog.ts";
import type { Check, CheckResult } from "./check.ts";

const execFileAsync = promisify(execFile);

export interface AgentCommandDeps {
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
  deps: AgentCommandDeps = {},
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

/** What an agent whose harness sets `github` needs beyond the factory's GitHub App: `gh`. */
export function agentGithubChecks(
  agents: readonly Harness[],
  deps: AgentCommandDeps = {},
): Check[] {
  if (!agents.some((agent) => agent.github !== undefined)) return [];
  return [
    agentCommandCheck(
      "agent.gh",
      "GitHub CLI for agents",
      "gh",
      "install the GitHub CLI (https://cli.github.com), on the PATH the service starts agents with",
      deps,
    ),
  ];
}
