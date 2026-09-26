import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import {
  type CodexAppServerProvider,
  type CodexAppServerSettings,
  createCodexAppServer,
  DEFAULT_MIN_CODEX_VERSION,
} from "ai-sdk-provider-codex-cli";
import { codexAuthCheck, harnessRuntimeCheck } from "../../../checks/harnesses.ts";
import { codexWorktreeConfigCheck } from "../../../checks/mcp.ts";
import { JigsError } from "../../../errors.ts";
import {
  type CodexHarness,
  codexPolicyKeys,
  type McpServerConfig,
} from "../../../workflow/agents/harness-config.ts";
import { recordRunDirectory } from "../../runtime/registry.ts";
import {
  codexRunStatePath,
  codexSessionFile,
  type PreparedCodexHome,
  prepareCodexInvocationHome,
} from "../harnesses/codex-home.ts";
import { resolveCodexExecutable } from "../harnesses/executables.ts";
import { AgentSessionError } from "../session-error.ts";
import { codexAppServerStepSettings } from "./codex-support.ts";
import { descriptorSettings } from "./descriptor-settings.ts";
import type { Driver, DriverRequest, HarnessTarget, OpenContext, OpenedModel } from "./types.ts";

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
function descriptor(request: DriverRequest): CodexHarness {
  if (!("harness" in request) || request.harness.kind !== "codex")
    throw new JigsError("the Codex driver requires a Codex request");
  return request.harness;
}

export interface CodexDriverDependencies {
  prepareCodexHome(runId: string): PreparedCodexHome | Promise<PreparedCodexHome>;
  sessionFile(sessionDir: string, threadId: string): string | undefined;
  createAppServer(): CodexAppServerProvider;
}

const defaultDependencies: CodexDriverDependencies = {
  prepareCodexHome: async (runId) => {
    await recordRunDirectory("codex-home", runId, codexRunStatePath(runId));
    return prepareCodexInvocationHome(runId);
  },
  sessionFile: codexSessionFile,
  createAppServer: () => createCodexAppServer(),
};

export function createCodexDriver(
  deps: CodexDriverDependencies = defaultDependencies,
): Driver<"codex"> {
  // Each step gets its own app server and private home; closing the model
  // stops the one and removes the other.
  async function open(target: HarnessTarget, context: OpenContext): Promise<OpenedModel> {
    const harness = descriptor(target);
    const { resume } = target;
    const prepared = await deps.prepareCodexHome(context.metadata.workflowRunId);
    let provider: CodexAppServerProvider | undefined;
    const close = async () => {
      try {
        await provider?.close();
      } finally {
        prepared.cleanup();
      }
    };
    try {
      if (resume !== undefined && deps.sessionFile(prepared.sessionDir, resume.id) === undefined) {
        throw new AgentSessionError(
          `Codex session ${resume.id} is missing from ${prepared.sessionDir}`,
        );
      }
      provider = deps.createAppServer();
      const model = provider(
        harness.model,
        codexAppServerStepSettings({
          ...descriptorSettings(harness, codexPolicyKeys),
          cwd: target.cwd,
          codexHome: prepared.home,
          env: context.env,
          approvalPolicy: "never",
          sandboxPolicy: "danger-full-access",
          autoApprove: true,
          ...(harness.mcpServers === undefined
            ? {}
            : { mcpServers: mcpServers(harness.mcpServers) }),
        }),
      );
      // The thread rides on the call, not the settings: a persistent-mode
      // model given a resume setting warns on every launch.
      return {
        model:
          resume === undefined
            ? model
            : wrapLanguageModel({
                model,
                middleware: defaultSettingsMiddleware({
                  settings: { providerOptions: { "codex-app-server": { threadId: resume.id } } },
                }),
              }),
        close,
      };
    } catch (err) {
      await close();
      throw err;
    }
  }

  return {
    kind: "codex",
    family: "harness",
    open,
    installationChecks: () => [harnessRuntimeCheck("codex"), codexAuthCheck()],
    requestChecks: () => [],
    jitChecks: (target) => [codexWorktreeConfigCheck(target.cwd)],
    envAllowlist: () => [],
    sessionPointer: { providerKey: "codex-app-server", field: "threadId" },
    setsEnv: ["CODEX_HOME"],
    displayName: "Codex",
    resolveExecutable: resolveCodexExecutable,
    minimumVersion: DEFAULT_MIN_CODEX_VERSION,
  } satisfies Driver<"codex">;
}

export const codexDriver = createCodexDriver();
