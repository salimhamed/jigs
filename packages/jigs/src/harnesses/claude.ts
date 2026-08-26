import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";

export class ClaudeExecutableMissingError extends Error {
  constructor() {
    super(
      "no `claude` executable found on PATH — install the Claude Code CLI, or set JIGS_CLAUDE_EXECUTABLE",
    );
    this.name = "ClaudeExecutableMissingError";
  }
}

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
  throw new ClaudeExecutableMissingError();
}

export type ClaudeStepOptions = ClaudeCodeSettings & { cwd: string };

// Force-merged AFTER caller options so the invariants cannot be overridden:
// strictMcpConfig makes the step's explicit mcpServers the entire MCP
// universe (ADR 0011); settingSources ['project'] is how skills and config
// reach the agent through the worktree (ADR 0004). Framework options
// (permissionMode, skills, systemPrompt) belong to the step builders
// (AGE-311), not here.
export function claudeStepSettings(
  options: ClaudeStepOptions,
): ClaudeCodeSettings {
  return {
    ...options,
    strictMcpConfig: true,
    settingSources: ["project"],
    pathToClaudeCodeExecutable:
      options.pathToClaudeCodeExecutable ?? resolveClaudeExecutable(),
  };
}
