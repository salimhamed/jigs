import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { getErrorMetadata, isAuthenticationError } from "ai-sdk-provider-claude-code";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { buildAgentRequest, buildAskAgentRequest } from "../../../blocks/agents/plan.ts";
import { claudeDriver } from "../drivers/claude.ts";
import { claudeProcessSpawner, claudeStepSettings } from "../drivers/claude-support.ts";
import { defaultAgentExecutionDependencies } from "../execute-agent.ts";
import { scrubbedEnv } from "./env.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

let tmp: string;
let worktree: string;
let fixture: string;

beforeAll(() => {
  tmp = makeTmpDir();
  worktree = path.join(tmp, "worktree");
  mkdirSync(worktree);
  fixture = path.join(tmp, "claude-fixture.mjs");
  writeFileSync(
    fixture,
    `import { writeFileSync } from "node:fs";
writeFileSync(process.env.JIGS_CLAUDE_TEST_RECORD, JSON.stringify({
  aws: "AWS_SECRET_ACCESS_KEY" in process.env,
  anthropic: "ANTHROPIC_API_KEY" in process.env,
  entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
  allowedToken: process.env.JIGS_ALLOWED_TOKEN,
  cwd: process.cwd(),
  args: process.argv.slice(2),
}));
writeFileSync(2, "Please run /login\\n");
process.exitCode = 1;
`,
  );
});

afterAll(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

test("claudeStepSettings preserves caller policy and wires the isolated launcher", () => {
  const settings = claudeStepSettings(
    {
      cwd: "/worktree",
      strictMcpConfig: true,
      settingSources: ["project"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      pathToClaudeCodeExecutable: "/opt/claude",
    },
    [],
  );
  expect(settings.strictMcpConfig).toBe(true);
  expect(settings.settingSources).toEqual(["project"]);
  expect(settings.permissionMode).toBe("bypassPermissions");
  expect(settings.allowDangerouslySkipPermissions).toBe(true);
  expect(settings.cwd).toBe("/worktree");
  expect(settings.pathToClaudeCodeExecutable).toBe("/opt/claude");
  expect(settings.spawnClaudeCodeProcess).toBeTypeOf("function");
});

test("the real provider launch isolates ask and run and preserves stderr auth classification", async () => {
  if (!claudeDriver.ask || !claudeDriver.run) throw new Error("Claude driver is incomplete");

  vi.stubEnv("JIGS_CLAUDE_EXECUTABLE", fixture);
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "synthetic-aws-secret");
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic-secret");
  vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "parent-claude-session");

  const cases = [
    {
      name: "ask",
      request: buildAskAgentRequest({
        harness: { kind: "claude", model: "sonnet" },
        prompt: "answer",
      }),
      cwd: process.cwd(),
    },
    {
      name: "run",
      request: buildAgentRequest({
        harness: { kind: "claude", model: "sonnet" },
        cwd: worktree,
        prompt: "implement",
      }),
      cwd: worktree,
    },
  ] as const;

  for (const testCase of cases) {
    const record = path.join(tmp, `${testCase.name}-env.json`);
    const context = {
      metadata: { workflowRunId: `run-${testCase.name}` },
      deps: { ...defaultAgentExecutionDependencies, generateText },
      env: {
        ...scrubbedEnv(claudeDriver.envAllowlist(testCase.request)),
        JIGS_CLAUDE_TEST_RECORD: record,
      },
    };

    let error: unknown;
    try {
      if (testCase.request.cwd === undefined) await claudeDriver.ask(testCase.request, context);
      else await claudeDriver.run(testCase.request, context);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ message: expect.stringContaining("Please run /login") });
    expect(isAuthenticationError(error), `${testCase.name} stderr classification`).toBe(true);
    expect(getErrorMetadata(error)?.stderr).toContain("Please run /login");
    expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({
      aws: false,
      anthropic: false,
      entrypoint: "sdk-ts",
      cwd: testCase.cwd,
    });
  }

  expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("synthetic-aws-secret");
  expect(process.env.ANTHROPIC_API_KEY).toBe("synthetic-anthropic-secret");
  expect(process.env.CLAUDE_CODE_ENTRYPOINT).toBe("parent-claude-session");
});

function launchFixture(
  allowlist: readonly string[],
  env: Record<string, string>,
  args: readonly string[] = [fixture],
) {
  return claudeProcessSpawner(allowlist)({
    command: process.execPath,
    args: [...args],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "", ...env },
    signal: new AbortController().signal,
  });
}

function exited(child: ReturnType<typeof launchFixture>) {
  return new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve([code, signal]));
  });
}

test("explicitly allowlisted variables survive the launch scrub", async () => {
  const record = path.join(tmp, "allowlist-env.json");
  const child = launchFixture(["JIGS_ALLOWED_TOKEN"], {
    JIGS_CLAUDE_TEST_RECORD: record,
    JIGS_ALLOWED_TOKEN: "kept",
    ANTHROPIC_API_KEY: "dropped",
  });
  const errors: unknown[] = [];
  child.stdout.on("error", (error) => errors.push(error));
  await expect(exited(child)).resolves.toEqual([0, null]);
  expect(errors).toHaveLength(1);
  expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({
    allowedToken: "kept",
    anthropic: false,
    entrypoint: "sdk-ts",
  });
});

test("a kill through the launcher is a teardown, not a launch failure", async () => {
  const child = launchFixture([], {}, [
    "-e",
    'process.stdout.write(\'{"type":"result"}\\n\'); setInterval(() => {}, 1000);',
  ]);
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  try {
    await new Promise((resolve) => child.stdout.once("data", resolve));
    child.stdout.removeAllListeners("data");
    const errors: unknown[] = [];
    child.stdout.on("error", (error) => errors.push(error));
    child.kill("SIGTERM");
    await expect(exited(child)).resolves.toEqual([null, "SIGTERM"]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors).toEqual([]);
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  expect(uncaught).toEqual([]);
});

test("claudeStepSettings resolves the executable when not supplied", () => {
  const prev = process.env.JIGS_CLAUDE_EXECUTABLE;
  process.env.JIGS_CLAUDE_EXECUTABLE = "/opt/claude-from-env";
  try {
    expect(claudeStepSettings({ cwd: "/worktree" }, []).pathToClaudeCodeExecutable).toBe(
      "/opt/claude-from-env",
    );
  } finally {
    if (prev === undefined) delete process.env.JIGS_CLAUDE_EXECUTABLE;
    else process.env.JIGS_CLAUDE_EXECUTABLE = prev;
  }
});
