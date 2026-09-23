import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { CLAUDE_ENV } from "../steps/agents/drivers/claude-support.ts";
import { driverFor } from "../steps/agents/drivers/index.ts";
import { realCodexAuthPath } from "../steps/agents/harnesses/codex-home.ts";
import { factoryAgentEnv, harnessEnv } from "../steps/agents/harnesses/env.ts";
import { resolveClaudeExecutable } from "../steps/agents/harnesses/executables.ts";
import { realPiAuthPath } from "../steps/agents/harnesses/pi-home.ts";
import { type Check, type CheckResult, PROBE_TIMEOUT_MS } from "./catalog.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "./core.ts";
import { type HarnessKind, type HarnessRuntimeDeps, harnessRuntime } from "./harness-runtime.ts";
import type { WorkflowRequires } from "./index.ts";

const execFileAsync = promisify(execFile);

export type { HarnessKind } from "./harness-runtime.ts";

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
          repair: `install the Claude Code CLI, or set JIGS_CLAUDE_EXECUTABLE in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`,
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
          repair: "run: claude auth login",
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
          repair: "check the Claude Code CLI version — jigs reads `claude auth status --json`",
        };
      }

      if (status.loggedIn !== true) {
        return {
          ok: false,
          reason: "the Claude Code CLI is not logged in",
          repair: "run: claude auth login",
        };
      }
      // Exit code is not a signal: the CLI reports an API-key override at
      // exit 0 while still saying authMethod claude.ai, so apiKeySource is
      // the field that actually catches it.
      if (status.apiKeySource != null) {
        return {
          ok: false,
          reason: `the Claude Code CLI is using an API key from ${String(status.apiKeySource)} instead of the subscription login`,
          repair: `remove ${String(status.apiKeySource)} from ${SERVICE_ENV_FILE} (and from the shell you start the service from), then: ${RESTART_SERVICE}`,
        };
      }
      if (status.authMethod !== "claude.ai") {
        return {
          ok: false,
          reason: `the Claude Code CLI reports authMethod ${JSON.stringify(status.authMethod)}, not "claude.ai"`,
          repair: "log in with the subscription account: claude auth login",
        };
      }
      return { ok: true };
    },
  };
}

// A login file only, never a version.
export function codexAuthCheck(authPath = realCodexAuthPath()): Check {
  return {
    id: "harness.codex-auth",
    label: "Codex subscription login",
    run: async (): Promise<CheckResult> => {
      let raw: string;
      try {
        raw = readFileSync(authPath, "utf8");
      } catch {
        return {
          ok: false,
          reason: `no Codex login found at ${authPath}`,
          repair: "run: codex login",
        };
      }
      let auth: { auth_mode?: unknown };
      try {
        auth = JSON.parse(raw) as { auth_mode?: unknown };
      } catch {
        return {
          ok: false,
          reason: `${authPath} is not readable JSON`,
          repair: `remove ${authPath} and run: codex login`,
        };
      }
      // Deliberately no expiry gating: codex refreshes its JWT lazily, so a
      // stale-looking token is still a valid login.
      if (auth.auth_mode !== "chatgpt") {
        return {
          ok: false,
          reason: `${authPath} reports auth_mode ${JSON.stringify(auth.auth_mode)}, not "chatgpt"`,
          repair: `log in with the ChatGPT subscription: codex logout && codex login (and unset OPENAI_API_KEY in ${SERVICE_ENV_FILE})`,
        };
      }
      return { ok: true };
    },
  };
}

/** Check that Pi's shared login file contains an OpenAI Codex login. */
export function piOpenaiCodexAuthCheck(authPath = realPiAuthPath()): Check {
  return {
    id: "harness.pi-openai-codex-auth",
    label: "Pi OpenAI Codex login",
    run: async (): Promise<CheckResult> => {
      let auth: unknown;
      try {
        auth = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
      } catch {
        return {
          ok: false,
          reason: `no readable Pi login found at ${authPath}`,
          repair: "run: pi, then choose /login and OpenAI Codex",
        };
      }
      if (typeof auth !== "object" || auth === null || !("openai-codex" in auth)) {
        return {
          ok: false,
          reason: `${authPath} has no OpenAI Codex login`,
          repair: "run: pi, then choose /login and OpenAI Codex",
        };
      }
      return { ok: true };
    },
  };
}

/** The same check the service gates its boot on, so doctor cannot pass
 *  something the service would refuse. */
export function harnessRuntimeCheck(kind: HarnessKind, deps: HarnessRuntimeDeps = {}): Check {
  const driver = driverFor(kind);
  return {
    id: `harness.${kind}-cli`,
    label: `${driver?.displayName ?? kind} CLI`,
    run: async (): Promise<CheckResult> => {
      const runtime = await harnessRuntime(kind, deps);
      return runtime.ok
        ? { ok: true, detail: runtime.line }
        : { ok: false, reason: runtime.line, repair: runtime.repair };
    },
  };
}

export function harnessChecks(kinds: HarnessKind[]): Check[] {
  return [...new Set(kinds)].flatMap((kind) => {
    const driver = driverFor(kind);
    return driver === undefined ? [missingDriverCheck(kind)] : driver.installationChecks();
  });
}

/** Map each harness named in a workflow's `requires` to the workflows that name it. */
export function harnessUsers(
  workflows: Record<string, { requires?: WorkflowRequires }>,
): Map<HarnessKind, string[]> {
  const users = new Map<HarnessKind, string[]>();
  for (const [name, entry] of Object.entries(workflows)) {
    for (const kind of new Set(entry.requires?.harnesses ?? [])) {
      users.set(kind, [...(users.get(kind) ?? []), name]);
    }
  }
  return users;
}

export function neededBy(workflows: readonly string[]): string {
  return `needed by ${workflows.length === 1 ? "workflow" : "workflows"} ${workflows.join(", ")}`;
}

/** The installation checks of each used harness, each failure naming the workflows that need it. */
export function usedHarnessChecks(users: Map<HarnessKind, string[]>): Check[] {
  return [...users].flatMap(([kind, workflows]) =>
    harnessChecks([kind]).map(
      (check): Check => ({
        ...check,
        run: async () => {
          const result = await check.run();
          return result.ok
            ? result
            : { ...result, reason: `${result.reason} (${neededBy(workflows)})` };
        },
      }),
    ),
  );
}

/** Diagnose a descriptor kind that this release cannot execute. */
export function missingDriverCheck(kind: string): Check {
  return {
    id: `driver.${kind}`,
    label: `${kind} driver`,
    run: async () => ({
      ok: false,
      reason: `no driver is registered for ${kind}`,
      repair: "install a jigs release that provides this driver",
    }),
  };
}
