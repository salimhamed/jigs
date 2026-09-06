import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";

// Always resolved explicitly: the Nitro build severs the provider's vendored
// binary, and pointing at the system `claude` keeps dev and the built service
// behaving identically.
export function resolveClaudeExecutable(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.JIGS_CLAUDE_EXECUTABLE;
  if (override !== undefined && override !== "") return override;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, "claude");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep scanning
    }
  }
  throw new Error(
    "no `claude` executable found on PATH — install the Claude Code CLI, or set JIGS_CLAUDE_EXECUTABLE",
  );
}

export type ClaudeStepOptions = ClaudeCodeSettings & { cwd: string };

// Force-merged AFTER caller options so the invariants cannot be overridden:
// strictMcpConfig makes the step's explicit mcpServers the entire MCP
// universe (ADR 0011); settingSources ['project'] is how skills and config
// reach the agent through the worktree (ADR 0004); bypassPermissions is what
// makes a headless agent possible at all — below it Bash prompts, and a
// prompt no one can answer hangs the step. The provider gates that mode
// behind the paired allowDangerouslySkipPermissions flag.
export function claudeStepSettings(
  options: ClaudeStepOptions,
): ClaudeCodeSettings {
  return {
    ...options,
    strictMcpConfig: true,
    settingSources: ["project"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    pathToClaudeCodeExecutable:
      options.pathToClaudeCodeExecutable ?? resolveClaudeExecutable(),
  };
}
