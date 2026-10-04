import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROBE_TIMEOUT_MS } from "../../../checks/catalog.ts";
import type { Check, CheckResult } from "../../../checks/check.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "../../../providers/credentials.ts";
import { factoryAgentEnv, harnessEnv } from "../harnesses/env.ts";
import { resolveClaudeExecutable } from "../harnesses/executables.ts";
import { CLAUDE_ENV } from "./claude-support.ts";

const execFileAsync = promisify(execFile);

export interface ClaudeAuthDeps {
  exec?: (
    file: string,
    args: string[],
    options: { env: Record<string, string>; timeout: number },
  ) => Promise<{ stdout: string }>;
  env?: NodeJS.ProcessEnv;
  factoryEnv?: () => readonly string[];
}

type ClaudeAuthStatus = {
  loggedIn?: unknown;
  authMethod?: unknown;
  apiKeySource?: unknown;
};

// A login probe only; the CLI itself is harnessRuntimeCheck's business.
// Heuristic, never a model call. The probe runs under the environment a step
// gives Claude Code, so it sees the same login the step will.
export function claudeAuthCheck(deps: ClaudeAuthDeps = {}): Check {
  const exec = deps.exec ?? execFileAsync;
  const env = deps.env ?? process.env;
  return {
    id: "harness.claude-auth",
    label: "Claude subscription login",
    run: async (): Promise<CheckResult> => {
      let executable: string;
      try {
        executable = resolveClaudeExecutable(env);
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
          repair: `install the Claude Code CLI, or set JIGS_CLAUDE_EXECUTABLE in ${SERVICE_ENV_FILE}, then: \`${RESTART_SERVICE}\``,
        };
      }

      const probeEnv = harnessEnv([...CLAUDE_ENV, ...(deps.factoryEnv ?? factoryAgentEnv)()], env);
      let stdout: string;
      try {
        ({ stdout } = await exec(executable, ["auth", "status", "--json"], {
          env: probeEnv,
          timeout: PROBE_TIMEOUT_MS,
        }));
      } catch (err) {
        return {
          ok: false,
          reason: `\`${executable} auth status --json\` failed: ${err}`,
          repair: "run: `claude auth login`",
        };
      }

      let status: ClaudeAuthStatus;
      try {
        status = JSON.parse(stdout) as ClaudeAuthStatus;
      } catch {
        // Fail closed: an answer we cannot read is not evidence of a login.
        return {
          ok: false,
          reason: `\`claude auth status --json\` did not answer JSON: ${stdout.slice(0, 200)}`,
          repair: "update the Claude Code CLI, since jigs could not read its auth status JSON",
        };
      }

      if (status.loggedIn !== true) {
        return {
          ok: false,
          reason: "the Claude Code CLI is not logged in",
          repair: "run: `claude auth login`",
        };
      }
      // Exit code is not a signal: the CLI reports an API-key override at
      // exit 0 while still saying authMethod claude.ai, so apiKeySource is
      // the field that actually catches it.
      if (status.apiKeySource != null) {
        return {
          ok: false,
          reason: `the Claude Code CLI is using an API key from ${String(status.apiKeySource)} instead of the subscription login`,
          repair: `remove ${String(status.apiKeySource)} from ${SERVICE_ENV_FILE} (and from the shell you start the service from), then: \`${RESTART_SERVICE}\``,
        };
      }
      if (status.authMethod !== "claude.ai") {
        return {
          ok: false,
          reason: `the Claude Code CLI reports authMethod ${JSON.stringify(status.authMethod)}, not "claude.ai"`,
          repair: "log in with the subscription account: `claude auth login`",
        };
      }
      return { ok: true };
    },
  };
}
