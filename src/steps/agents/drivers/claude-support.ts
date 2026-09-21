import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { resolveClaudeExecutable } from "../harnesses/executables.ts";

export type ClaudeStepOptions = ClaudeCodeSettings & { cwd: string };

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
