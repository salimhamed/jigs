import type { CodexAppServerProvider, CodexAppServerSettings } from "ai-sdk-provider-codex-cli";
import { codexAuthCheck, harnessRuntimeCheck } from "../../../checks/harnesses.ts";
import { codexWorktreeConfigCheck } from "../../../checks/mcp.ts";
import { JigsError } from "../../../errors.ts";
import type { CodexHarness, McpServerConfig } from "../../../workflow/agents/harness-config.ts";
import type { AgentRequest } from "../../../workflow/agents/plan.ts";
import {
  codexSessionFile,
  type PreparedCodexHome,
  prepareCodexInvocationHome,
} from "../harnesses/codex-home.ts";
import { resolveCodexExecutable } from "../harnesses/executables.ts";
import { DEFAULT_MIN_CODEX_VERSION } from "../harnesses/index.ts";
import { AgentSessionError } from "../session-error.ts";
import { codexAppServerStepSettings, withCodexAppServer } from "./codex-support.ts";
import type { Driver, DriverContext, RunRequest } from "./types.ts";

type CodexMcpServerConfig = NonNullable<CodexAppServerSettings["mcpServers"]>[string];
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
  if (request.harness.kind !== "codex")
    throw new JigsError("the Codex driver requires a Codex request");
  return request.harness;
}

export interface CodexDriverDependencies {
  prepareCodexHome(runId: string): PreparedCodexHome;
  sessionFile(sessionDir: string, threadId: string): string | undefined;
  withCodexAppServer<T>(fn: (provider: CodexAppServerProvider) => Promise<T>): Promise<T>;
}

const defaultDependencies: CodexDriverDependencies = {
  prepareCodexHome: (runId) => prepareCodexInvocationHome(runId),
  sessionFile: codexSessionFile,
  withCodexAppServer,
};

export function createCodexDriver(
  deps: CodexDriverDependencies = defaultDependencies,
): Driver<"codex"> {
  async function run(request: RunRequest, context: DriverContext) {
    const harness = descriptor(request);
    const { resume } = request;
    const prepared = deps.prepareCodexHome(context.metadata.workflowRunId);
    try {
      if (resume !== undefined && deps.sessionFile(prepared.sessionDir, resume.id) === undefined) {
        throw new AgentSessionError(
          `Codex session ${resume.id} is missing from ${prepared.sessionDir}`,
        );
      }
      return await deps.withCodexAppServer((provider) =>
        context.deps.generateText({
          model: provider(
            harness.model,
            codexAppServerStepSettings({
              cwd: request.cwd,
              codexHome: prepared.home,
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
    } finally {
      prepared.cleanup();
    }
  }

  return {
    kind: "codex",
    family: "harness",
    run,
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
