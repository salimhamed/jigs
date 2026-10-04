import { wrapLanguageModel } from "ai";
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
import { recordRunDirectory } from "../../runtime/registry.ts";
import type { RunMetadata } from "../../runtime/run-context.ts";
import { resolveClaudeExecutable } from "../harnesses/executables.ts";
import { mcpCredentialVariables, resolveMcpServer } from "../harnesses/mcp-credentials.ts";
import {
  claudePluginsPath,
  prepareClaudeSkillsPlugin,
  type SkillsPlugin,
} from "../harnesses/skills.ts";
import { AgentSessionError } from "../session-error.ts";
import { acceptedStructuredAnswer } from "./claude-structured-output.ts";
import { CLAUDE_ENV, claudeStepSettings } from "./claude-support.ts";
import { descriptorSettings } from "./descriptor-settings.ts";
import type { Driver, DriverRequest, ExecutorGeneration, OpenedModel } from "./types.ts";

function mcpServers(
  servers: Record<string, McpServerConfig>,
  env: Record<string, string>,
): Record<string, ClaudeMcpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      const resolved = resolveMcpServer(server, env);
      return [
        name,
        "command" in resolved ? { type: "stdio", ...resolved } : { type: "http", ...resolved },
      ];
    }),
  );
}

function owner(run: RunMetadata): string {
  return `Claude Code for run ${run.workflowRunId}`;
}

function descriptor(request: DriverRequest): ClaudeHarness {
  if (!("harness" in request) || request.harness.kind !== "claude") {
    throw new JigsError("the Claude driver requires a Claude request");
  }
  return request.harness;
}

export interface ClaudeDriverDependencies {
  sessionMessages(sessionId: string, cwd: string): Promise<readonly unknown[]>;
  prepareSkillsPlugin(runId: string, skills: readonly string[]): Promise<SkillsPlugin>;
}

const defaultDependencies: ClaudeDriverDependencies = {
  sessionMessages: (sessionId, cwd) =>
    getSessionMessages(sessionId, {
      dir: cwd,
      limit: 1,
      includeSystemMessages: true,
    }),
  prepareSkillsPlugin: async (runId, skills) => {
    await recordRunDirectory("claude-plugins", runId, claudePluginsPath(runId));
    return prepareClaudeSkillsPlugin(runId, skills);
  },
};

export function createClaudeDriver(
  overrides: Partial<ClaudeDriverDependencies> = {},
): Driver<"claude"> {
  const deps = { ...defaultDependencies, ...overrides };
  const driver: Driver<"claude"> = {
    kind: "claude",
    family: "harness",
    open: async (target, context): Promise<OpenedModel> => {
      const harness = descriptor(target);
      const { cwd, resume } = target;
      if (resume !== undefined && (await deps.sessionMessages(resume.id, cwd)).length === 0) {
        throw new AgentSessionError(`Claude session ${resume.id} is missing for ${cwd}`);
      }
      const plugin =
        harness.skills === undefined || harness.skills.length === 0
          ? undefined
          : await deps.prepareSkillsPlugin(context.metadata.workflowRunId, harness.skills);
      try {
        const settings = claudeStepSettings({
          ...descriptorSettings(harness, claudePolicyKeys),
          cwd,
          env: context.env,
          signal: context.signal,
          owner: owner(context.metadata),
          strictMcpConfig: true,
          settingSources: ["project"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          ...(resume === undefined ? {} : { resume: resume.id }),
          ...(harness.mcpServers === undefined
            ? {}
            : { mcpServers: mcpServers(harness.mcpServers, context.env) }),
          ...(plugin === undefined
            ? {}
            : { plugins: [{ type: "local", path: plugin.path, skipMcpDiscovery: true }] }),
        });
        return {
          model: wrapLanguageModel({
            model: claudeCode(harness.model, settings),
            middleware: acceptedStructuredAnswer,
          }),
          close: async () => {
            try {
              await settings.spawnClaudeCodeProcess.close();
            } finally {
              plugin?.cleanup();
            }
          },
        };
      } catch (error) {
        plugin?.cleanup();
        throw error;
      }
    },
    ask: async (request, context): Promise<ExecutorGeneration> => {
      const harness = descriptor(request);
      const settings = claudeStepSettings({
        // An empty MCP universe still leaves Claude Code's built-in tools.
        tools: [],
        strictMcpConfig: true,
        mcpServers: {},
        settingSources: [],
        env: context.env,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        owner: owner(context.metadata),
      });
      try {
        return await context.deps.generateText({
          model: claudeCode(harness.model, settings),
          prompt: request.prompt,
          ...("system" in request && request.system !== undefined
            ? { system: request.system }
            : {}),
          ...(context.output === undefined ? {} : { output: context.output }),
          abortSignal: context.signal,
        });
      } finally {
        await settings.spawnClaudeCodeProcess.close();
      }
    },
    installationChecks: () => [harnessRuntimeCheck("claude"), claudeAuthCheck()],
    requestChecks: () => [],
    envAllowlist: (request) => [
      ...CLAUDE_ENV,
      ...("harness" in request && request.harness.kind === "claude"
        ? mcpCredentialVariables(request.harness.mcpServers ?? {})
        : []),
    ],
    sessionPointer: { providerKey: "claude-code", field: "sessionId" },
    setsEnv: [],
    displayName: "Claude Code",
    resolveExecutable: resolveClaudeExecutable,
  };
  return driver;
}

export const claudeDriver = createClaudeDriver();
