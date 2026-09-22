import {
  type McpServerConfig as ClaudeMcpServerConfig,
  getSessionInfo,
} from "ai-sdk-provider-claude-code";
import type { ClaudeHarness, McpServerConfig } from "../../../blocks/agents/harness-config.ts";
import type { AgentRequest } from "../../../blocks/agents/plan.ts";
import { claudeAuthCheck, harnessRuntimeCheck } from "../../../checks/harnesses.ts";
import { resolveClaudeExecutable } from "../harnesses/executables.ts";
import { claudeCode } from "../harnesses/index.ts";
import { AgentSessionError } from "../session-error.ts";
import { claudeStepSettings } from "./claude-support.ts";
import type { Driver, ExecutorGeneration } from "./types.ts";

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

function descriptor(request: AgentRequest): ClaudeHarness {
  return request.harness as ClaudeHarness;
}

export interface ClaudeDriverDependencies {
  sessionExists(sessionId: string, cwd: string): Promise<boolean>;
}

const defaultDependencies: ClaudeDriverDependencies = {
  sessionExists: async (sessionId, cwd) =>
    (await getSessionInfo(sessionId, { dir: cwd })) !== undefined,
};

export function createClaudeDriver(
  deps: ClaudeDriverDependencies = defaultDependencies,
): Driver<"claude"> {
  const driver: Driver<"claude"> = {
    kind: "claude",
    family: "harness",
    run: async (request, context): Promise<ExecutorGeneration> => {
      const harness = descriptor(request as AgentRequest);
      const resume = "resume" in request ? request.resume : undefined;
      const cwd = request.cwd as string;
      if (resume !== undefined && !(await deps.sessionExists(resume.id, cwd))) {
        throw new AgentSessionError(`Claude session ${resume.id} is missing for ${cwd}`);
      }
      return context.deps.generateText({
        model: claudeCode(
          harness.model,
          claudeStepSettings(
            {
              cwd,
              env: context.env,
              strictMcpConfig: true,
              settingSources: ["project"],
              permissionMode: "bypassPermissions",
              allowDangerouslySkipPermissions: true,
              ...(harness.effort === undefined ? {} : { effort: harness.effort }),
              ...(resume === undefined ? {} : { resume: resume.id }),
              ...(harness.mcpServers === undefined
                ? {}
                : { mcpServers: mcpServers(harness.mcpServers) }),
            },
            driver.envAllowlist(request),
          ),
        ),
        prompt: request.prompt,
        ...(context.output === undefined ? {} : { output: context.output }),
      });
    },
    ask: async (request, context): Promise<ExecutorGeneration> => {
      const harness = descriptor(request as AgentRequest);
      return context.deps.generateText({
        model: claudeCode(
          harness.model,
          claudeStepSettings(
            {
              strictMcpConfig: true,
              mcpServers: {},
              settingSources: [],
              env: context.env,
            },
            driver.envAllowlist(request),
          ),
        ),
        prompt: request.prompt,
        ...("system" in request && request.system !== undefined ? { system: request.system } : {}),
        ...(context.output === undefined ? {} : { output: context.output }),
      });
    },
    installationChecks: () => [harnessRuntimeCheck("claude"), claudeAuthCheck()],
    requestChecks: () => [],
    envAllowlist: () => [],
    sessionPointer: { providerKey: "claude-code", field: "sessionId" },
    docsAnchor: "claude-code",
    displayName: "Claude Code",
    resolveExecutable: resolveClaudeExecutable,
  };
  return driver;
}

export const claudeDriver = createClaudeDriver();
