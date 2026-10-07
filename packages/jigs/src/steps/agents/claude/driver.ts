import {
  type McpServerConfig as ClaudeMcpServerConfig,
  getSessionMessages,
  type Options,
  query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { JigsError } from "../../../errors.ts";
import {
  type ClaudeHarness,
  claudePolicyKeys,
  type McpServerConfig,
} from "../../../workflow/agents/harness-config.ts";
import type { AgentRequest } from "../../../workflow/agents/plan.ts";
import { recordRunDirectory } from "../../runtime/registry.ts";
import type { RunMetadata } from "../../runtime/run-context.ts";
import { descriptorSettings } from "../shared/descriptor-settings.ts";
import { resolveClaudeExecutable } from "../shared/executables.ts";
import { type HarnessCli, harnessRuntimeCheck } from "../shared/harness-runtime.ts";
import { mcpCredentialVariables, resolveMcpServer } from "../shared/mcp-credentials.ts";
import { AgentSessionError } from "../shared/session-error.ts";
import {
  claudePluginsPath,
  prepareClaudeSkillsPlugin,
  type SkillsPlugin,
} from "../shared/skills.ts";
import { createStreamTap, openStepStream, type StepStream } from "../shared/step-stream.ts";
import type {
  Driver,
  DriverContext,
  DriverRequest,
  ExecutorGeneration,
  RunRequest,
} from "../shared/types.ts";
import { claudeAuthCheck } from "./checks.ts";
import { claudeGeneration, claudeStreamParts } from "./messages.ts";
import { CLAUDE_ENV, claudeStepSettings } from "./process.ts";

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

// Each server's disabled tools join the descriptor's own, under Claude Code's MCP tool names.
function disallowedTools(harness: ClaudeHarness): string[] | undefined {
  const disabled = Object.entries(harness.mcpServers ?? {}).flatMap(([name, server]) =>
    (server.disabledTools ?? []).map((tool) => `mcp__${name}__${tool}`),
  );
  if (disabled.length === 0) return harness.disallowedTools;
  return [...(harness.disallowedTools ?? []), ...disabled];
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
  query(params: { prompt: string; options: Options }): AsyncIterable<SDKMessage>;
  sessionMessages(sessionId: string, cwd: string): Promise<readonly unknown[]>;
  prepareSkillsPlugin(runId: string, skills: readonly string[]): Promise<SkillsPlugin>;
  openStepStream(): StepStream | undefined;
}

const defaultDependencies: ClaudeDriverDependencies = {
  query,
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
  openStepStream,
};

const cli: HarnessCli<"claude"> = {
  kind: "claude",
  displayName: "Claude Code",
  resolveExecutable: resolveClaudeExecutable,
};

function outputFormat(schema: Record<string, unknown> | undefined): Pick<Options, "outputFormat"> {
  return schema === undefined ? {} : { outputFormat: { type: "json_schema", schema } };
}

export function createClaudeDriver(
  overrides: Partial<ClaudeDriverDependencies> = {},
): Driver<"claude"> {
  const deps = { ...defaultDependencies, ...overrides };

  // Reads up to the result: in a one-shot query Claude Code ends its turn there, and leaving the
  // loop closes the query.
  async function answer(
    prompt: string,
    options: Options,
    structured: boolean,
    onMessage?: (message: SDKMessage) => void,
  ): Promise<ExecutorGeneration> {
    let result: SDKResultMessage | undefined;
    let errorKind: string | undefined;
    for await (const message of deps.query({ prompt, options })) {
      onMessage?.(message);
      // Only the last assistant message's error explains how the turn ended.
      if (message.type === "assistant") errorKind = message.error;
      if (message.type === "result") {
        result = message;
        break;
      }
    }
    if (result === undefined) throw new Error("Claude Code ended without a result");
    return claudeGeneration(result, structured, errorKind);
  }

  async function run(request: RunRequest, context: DriverContext): Promise<ExecutorGeneration> {
    const harness = descriptor(request);
    const { cwd, resume } = request;
    if (resume !== undefined && (await deps.sessionMessages(resume.id, cwd)).length === 0) {
      throw new AgentSessionError(`Claude session ${resume.id} is missing for ${cwd}`);
    }
    const plugin =
      harness.skills === undefined || harness.skills.length === 0
        ? undefined
        : await deps.prepareSkillsPlugin(context.metadata.workflowRunId, harness.skills);
    const stream = deps.openStepStream();
    const tap =
      stream === undefined
        ? undefined
        : createStreamTap(stream, { harness: "claude", cwd, resume: resume !== undefined });
    try {
      const disallowed = disallowedTools(harness);
      const settings = claudeStepSettings({
        ...descriptorSettings(harness, claudePolicyKeys),
        ...(disallowed === undefined ? {} : { disallowedTools: disallowed }),
        model: harness.model,
        cwd,
        env: context.env,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        owner: owner(context.metadata),
        strictMcpConfig: true,
        settingSources: ["project"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        ...(resume === undefined ? {} : { resume: resume.id }),
        ...outputFormat(request.outputSchema),
        ...(harness.mcpServers === undefined
          ? {}
          : { mcpServers: mcpServers(harness.mcpServers, context.env) }),
        ...(plugin === undefined
          ? {}
          : { plugins: [{ type: "local", path: plugin.path, skipMcpDiscovery: true }] }),
      });
      try {
        const parts = claudeStreamParts();
        const generation = await answer(
          request.prompt,
          settings,
          request.outputSchema !== undefined,
          tap === undefined
            ? undefined
            : (message) => {
                for (const part of parts(message)) tap.write(part);
              },
        );
        await tap?.end();
        return generation;
      } finally {
        await settings.spawnClaudeCodeProcess.close();
      }
    } catch (error) {
      await tap?.end(error);
      throw error;
    } finally {
      plugin?.cleanup();
    }
  }

  async function ask(request: AgentRequest, context: DriverContext): Promise<ExecutorGeneration> {
    const harness = descriptor(request);
    const settings = claudeStepSettings({
      model: harness.model,
      // An empty MCP universe still leaves Claude Code's built-in tools.
      tools: [],
      strictMcpConfig: true,
      mcpServers: {},
      settingSources: [],
      env: context.env,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      owner: owner(context.metadata),
      ...outputFormat(request.outputSchema),
    });
    // Claude Code keeps its own system prompt; the request's leads the prompt.
    const prompt =
      "system" in request && request.system !== undefined
        ? `${request.system}\n\n${request.prompt}`
        : request.prompt;
    try {
      return await answer(prompt, settings, request.outputSchema !== undefined);
    } finally {
      await settings.spawnClaudeCodeProcess.close();
    }
  }

  const driver: Driver<"claude"> = {
    family: "harness",
    ask,
    run,
    installationChecks: () => [harnessRuntimeCheck(cli), claudeAuthCheck()],
    descriptorChecks: () => [],
    envAllowlist: (request) => [
      ...CLAUDE_ENV,
      ...("harness" in request && request.harness.kind === "claude"
        ? mcpCredentialVariables(request.harness.mcpServers ?? {})
        : []),
    ],
    sessionPointer: { providerKey: "claude", field: "sessionId" },
    setsEnv: [],
    mcpInheritsEnv: true,
    ...cli,
  };
  return driver;
}

export const claudeDriver = createClaudeDriver();
