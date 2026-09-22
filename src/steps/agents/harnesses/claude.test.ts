import type { SpawnedProcess } from "ai-sdk-provider-claude-code";
import { afterEach, expect, test, vi } from "vitest";
import { claudeProcessSpawner, claudeStepSettings } from "../drivers/claude-support.ts";

const boundaries = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: boundaries.spawn }));

afterEach(() => {
  vi.clearAllMocks();
});

function fakeChild() {
  return { process: "fake" } as unknown as SpawnedProcess;
}

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
  expect(settings.spawnClaudeCodeProcess).toBeTypeOf("function");
});

test("the Claude process seam reapplies credential isolation after provider assembly", () => {
  const child = fakeChild();
  boundaries.spawn.mockReturnValue(child);
  const signal = new AbortController().signal;
  const spawnClaude = claudeProcessSpawner(["EXPLICIT_API_KEY"]);

  const result = spawnClaude({
    command: "/opt/claude",
    args: ["--output-format", "stream-json"],
    cwd: "/worktree",
    signal,
    env: {
      PATH: "/usr/bin",
      HOME: "/home/tester",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      EXPLICIT_API_KEY: "allowed-secret",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    },
  });

  expect(result).toBe(child);
  expect(boundaries.spawn).toHaveBeenCalledWith("/opt/claude", ["--output-format", "stream-json"], {
    cwd: "/worktree",
    env: {
      PATH: "/usr/bin",
      HOME: "/home/tester",
      EXPLICIT_API_KEY: "allowed-secret",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    },
    signal,
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
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
