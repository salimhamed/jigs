import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CodexAppServerProvider, CodexExecSettings } from "ai-sdk-provider-codex-cli";
import type { CodexHarness, McpServerConfig } from "../../../blocks/agents/harness-config.ts";
import type { AgentRequest } from "../../../blocks/agents/plan.ts";
import { codexAuthCheck, harnessRuntimeCheck } from "../../../checks/harnesses.ts";
import { codexWorktreeConfigCheck } from "../../../checks/mcp.ts";
import { ensureManagedCodexHome } from "../harnesses/codex-home.ts";
import { resolveCodexExecutable } from "../harnesses/executables.ts";
import { codexExec, DEFAULT_MIN_CODEX_VERSION } from "../harnesses/index.ts";
import {
  codexAppServerStepSettings,
  codexExecStepSettings,
  withCodexAppServer,
} from "./codex-support.ts";
import type { Driver, DriverContext } from "./types.ts";

type CodexMcpServerConfig = NonNullable<CodexExecSettings["mcpServers"]>[string];
function mcpServers(
  servers: Record<string, McpServerConfig>,
): Record<string, CodexMcpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      "command" in server
        ? {
            transport: "stdio",
            command: server.command,
            ...(server.args === undefined ? {} : { args: server.args }),
            ...(server.env === undefined ? {} : { env: server.env }),
          }
        : {
            transport: "http",
            url: server.url,
            ...(server.headers === undefined ? {} : { httpHeaders: server.headers }),
          },
    ]),
  );
}
function descriptor(request: AgentRequest): CodexHarness {
  return request.harness as CodexHarness;
}

export interface CodexDriverDependencies {
  ensureCodexHome(runId: string): string;
  withCodexAppServer<T>(fn: (provider: CodexAppServerProvider) => Promise<T>): Promise<T>;
}

const defaultDependencies: CodexDriverDependencies = {
  ensureCodexHome: (runId) => ensureManagedCodexHome(runId),
  withCodexAppServer,
};

export function createCodexDriver(
  deps: CodexDriverDependencies = defaultDependencies,
): Driver<"codex"> {
  async function run(request: AgentRequest, context: DriverContext) {
    const harness = descriptor(request);
    const resume = "resume" in request ? request.resume : undefined;
    return deps.withCodexAppServer((provider) =>
      context.deps.generateText({
        model: provider(
          harness.model,
          codexAppServerStepSettings({
            cwd: request.cwd as string,
            codexHome: deps.ensureCodexHome(context.metadata.workflowRunId),
            env: context.env,
            ...(harness.effort === undefined ? {} : { effort: harness.effort }),
            approvalPolicy: "never",
            sandboxPolicy: "danger-full-access",
            autoApprove: true,
            ...(harness.mcpServers === undefined
              ? {}
              : { mcpServers: mcpServers(harness.mcpServers) }),
          }),
        ),
        prompt: request.prompt,
        ...(context.output === undefined ? {} : { output: context.output }),
        ...(resume === undefined
          ? {}
          : { providerOptions: { "codex-app-server": { threadId: resume.id } } }),
      }),
    );
  }

  async function ask(request: AgentRequest, context: DriverContext) {
    const harness = descriptor(request);
    const scratch = mkdtempSync(path.join(tmpdir(), "jigs-ask-"));
    try {
      return await context.deps.generateText({
        model: codexExec(
          harness.model,
          codexExecStepSettings({
            cwd: scratch,
            codexHome: deps.ensureCodexHome(context.metadata.workflowRunId),
            env: context.env,
            approvalMode: "never",
            sandboxMode: "read-only",
          }),
        ),
        prompt: request.prompt,
        ...("system" in request && request.system !== undefined ? { system: request.system } : {}),
        ...(context.output === undefined ? {} : { output: context.output }),
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  return {
    kind: "codex",
    family: "harness",
    run,
    ask,
    installationChecks: () => [harnessRuntimeCheck("codex"), codexAuthCheck()],
    requestChecks: () => [],
    jitChecks: (request) =>
      request.cwd === undefined ? [] : [codexWorktreeConfigCheck(request.cwd)],
    envAllowlist: () => [],
    sessionPointer: { providerKey: "codex-app-server", field: "threadId" },
    docsAnchor: "codex",
    displayName: "Codex",
    resolveExecutable: resolveCodexExecutable,
    minimumVersion: DEFAULT_MIN_CODEX_VERSION,
  } satisfies Driver<"codex">;
}

export const codexDriver = createCodexDriver();
