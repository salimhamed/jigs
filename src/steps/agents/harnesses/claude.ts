import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { resolveClaudeExecutable } from "./executables.ts";

export type ClaudeStepOptions = ClaudeCodeSettings & { cwd: string };

// Force-merged AFTER caller options so the invariants cannot be overridden:
// strictMcpConfig makes the step's explicit mcpServers the entire MCP
// universe; settingSources ['project'] is how skills and config reach the
// agent through the worktree; bypassPermissions is what makes a headless agent
// possible at all — below it Bash prompts, and a prompt no one can answer
// hangs the step. The provider gates that mode behind the paired
// allowDangerouslySkipPermissions flag.
export function claudeStepSettings(options: ClaudeStepOptions): ClaudeCodeSettings {
  return {
    ...options,
    strictMcpConfig: true,
    settingSources: ["project"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable ?? resolveClaudeExecutable(),
  };
}
