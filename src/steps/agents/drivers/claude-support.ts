import { spawn } from "node:child_process";
import type { ClaudeCodeSettings, SpawnedProcess, SpawnOptions } from "ai-sdk-provider-claude-code";
import { scrubbedEnv } from "../harnesses/env.ts";
import { resolveClaudeExecutable } from "../harnesses/executables.ts";

export type ClaudeStepOptions = ClaudeCodeSettings & { cwd: string };

// The provider adds this after merging its settings with process.env. It is
// runtime metadata, not a credential or a parent Claude session marker.
const PROVIDER_RUNTIME_ENV = ["CLAUDE_CODE_ENTRYPOINT"];

export function claudeProcessSpawner(
  allowlist: readonly string[] = [],
): NonNullable<ClaudeCodeSettings["spawnClaudeCodeProcess"]> {
  return (options: SpawnOptions): SpawnedProcess =>
    spawn(options.command, options.args, {
      cwd: options.cwd,
      env: scrubbedEnv([...allowlist, ...PROVIDER_RUNTIME_ENV], options.env),
      signal: options.signal,
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
}

export function claudeStepSettings(
  options: ClaudeStepOptions,
  envAllowlist: readonly string[] = [],
): ClaudeCodeSettings {
  return {
    ...options,
    strictMcpConfig: true,
    settingSources: ["project"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable ?? resolveClaudeExecutable(),
    spawnClaudeCodeProcess: claudeProcessSpawner(envAllowlist),
  };
}
