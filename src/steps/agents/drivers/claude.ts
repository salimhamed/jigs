import {
  type McpServerConfig as ClaudeMcpServerConfig,
  claudeCode,
  getSessionMessages,
} from "ai-sdk-provider-claude-code";
import { claudeAuthCheck, harnessRuntimeCheck } from "../../../checks/harnesses.ts";
import { JigsError } from "../../../errors.ts";
import {
  type ClaudeHarness,
  claudePolicyKeys,
  type McpServerConfig,
} from "../../../workflow/agents/harness-config.ts";
import { resolveClaudeExecutable } from "../harnesses/executables.ts";
import { AgentSessionError } from "../session-error.ts";
import { CLAUDE_ENV, claudeStepSettings } from "./claude-support.ts";
import { descriptorSettings } from "./descriptor-settings.ts";
import type { Driver, DriverRequest, ExecutorGeneration, OpenedModel } from "./types.ts";

function mcpServers(
  servers: Record<string, McpServerConfig>,
): Record<string, ClaudeMcpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      "command" in server
        ? {
            type: "stdio",
            command: server.command,
            ...(server.args === undefined ? {} : { args: server.args }),
            ...(server.env === undefined ? {} : { env: server.env }),
          }
        : {
            type: "http",
            url: server.url,
            ...(server.headers === undefined ? {} : { headers: server.headers }),
          },
    ]),
  );
}

function descriptor(request: DriverRequest): ClaudeHarness {
  if (!("harness" in request) || request.harness.kind !== "claude") {
    throw new JigsError("the Claude driver requires a Claude request");
  }
  return request.harness;
}

export interface ClaudeDriverDependencies {
  sessionMessages(sessionId: string, cwd: string): Promise<readonly unknown[]>;
}

const defaultDependencies: ClaudeDriverDependencies = {
  sessionMessages: (sessionId, cwd) =>
    getSessionMessages(sessionId, {
      dir: cwd,
      limit: 1,
      includeSystemMessages: true,
    }),
};

export function createClaudeDriver(
  deps: ClaudeDriverDependencies = defaultDependencies,
): Driver<"claude"> {
  const driver: Driver<"claude"> = {
    kind: "claude",
    family: "harness",
    open: async (target, context): Promise<OpenedModel> => {
      const harness = descriptor(target);
      const { cwd, resume } = target;
      if (resume !== undefined && (await deps.sessionMessages(resume.id, cwd)).length === 0) {
        throw new AgentSessionError(`Claude session ${resume.id} is missing for ${cwd}`);
      }
      const model = claudeCode(
        harness.model,
        claudeStepSettings({
          ...descriptorSettings(harness, claudePolicyKeys),
          cwd,
          env: context.env,
          strictMcpConfig: true,
          settingSources: ["project"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          ...(resume === undefined ? {} : { resume: resume.id }),
          ...(harness.mcpServers === undefined
            ? {}
            : { mcpServers: mcpServers(harness.mcpServers) }),
        }),
      );
      return { model, close: async () => {} };
    },
    ask: async (request, context): Promise<ExecutorGeneration> => {
      const harness = descriptor(request);
      return context.deps.generateText({
        model: claudeCode(
          harness.model,
          claudeStepSettings({
            // An empty MCP universe still leaves Claude Code's built-in tools.
            tools: [],
            strictMcpConfig: true,
            mcpServers: {},
            settingSources: [],
            env: context.env,
          }),
        ),
        prompt: request.prompt,
        ...("system" in request && request.system !== undefined ? { system: request.system } : {}),
        ...(context.output === undefined ? {} : { output: context.output }),
      });
    },
    installationChecks: () => [harnessRuntimeCheck("claude"), claudeAuthCheck()],
    requestChecks: () => [],
    envAllowlist: () => CLAUDE_ENV,
    sessionPointer: { providerKey: "claude-code", field: "sessionId" },
    setsEnv: [],
    displayName: "Claude Code",
    resolveExecutable: resolveClaudeExecutable,
  };
  return driver;
}

export const claudeDriver = createClaudeDriver();
