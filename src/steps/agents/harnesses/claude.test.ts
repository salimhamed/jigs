import { expect, test } from "vitest";
import { claudeStepSettings } from "../drivers/claude-support.ts";

test("claudeStepSettings force-merges the invariants over caller options", () => {
  const settings = claudeStepSettings({
    cwd: "/worktree",
    strictMcpConfig: false,
    settingSources: ["user", "project", "local"],
    permissionMode: "acceptEdits",
    pathToClaudeCodeExecutable: "/opt/claude",
  });
  expect(settings.strictMcpConfig).toBe(true);
  expect(settings.settingSources).toEqual(["project"]);
  expect(settings.permissionMode).toBe("bypassPermissions");
  expect(settings.allowDangerouslySkipPermissions).toBe(true);
  expect(settings.cwd).toBe("/worktree");
  expect(settings.pathToClaudeCodeExecutable).toBe("/opt/claude");
});

test("claudeStepSettings resolves the executable when not supplied", () => {
  const prev = process.env.JIGS_CLAUDE_EXECUTABLE;
  process.env.JIGS_CLAUDE_EXECUTABLE = "/opt/claude-from-env";
  try {
    expect(claudeStepSettings({ cwd: "/worktree" }).pathToClaudeCodeExecutable).toBe(
      "/opt/claude-from-env",
    );
  } finally {
    if (prev === undefined) delete process.env.JIGS_CLAUDE_EXECUTABLE;
    else process.env.JIGS_CLAUDE_EXECUTABLE = prev;
  }
});
