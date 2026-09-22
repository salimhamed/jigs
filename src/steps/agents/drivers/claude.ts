import type { McpServerConfig as ClaudeMcpServerConfig } from "ai-sdk-provider-claude-code";
import type { ClaudeHarness, McpServerConfig } from "../../../blocks/agents/harness-config.ts";
import type { AgentRequest } from "../../../blocks/agents/plan.ts";
import { claudeAuthCheck, harnessRuntimeCheck } from "../../../checks/harnesses.ts";
import { resolveClaudeExecutable } from "../harnesses/executables.ts";
import { claudeCode } from "../harnesses/index.ts";
import { claudeStepSettings } from "./claude-support.ts";
import type { Driver, DriverContext } from "./types.ts";

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

async function run(request: AgentRequest, context: DriverContext) {
  const harness = descriptor(request);
  const resume = "resume" in request ? request.resume : undefined;
  return context.deps.generateText({
    model: claudeCode(
      harness.model,
      claudeStepSettings({
        cwd: request.cwd as string,
        env: context.env,
        ...(harness.effort === undefined ? {} : { effort: harness.effort }),
        ...(resume === undefined ? {} : { resume: resume.id }),
        ...(harness.mcpServers === undefined ? {} : { mcpServers: mcpServers(harness.mcpServers) }),
      }),
    ),
    prompt: request.prompt,
    ...(context.output === undefined ? {} : { output: context.output }),
  });
}

async function ask(request: AgentRequest, context: DriverContext) {
  const harness = descriptor(request);
  return context.deps.generateText({
    model: claudeCode(harness.model, {
      strictMcpConfig: true,
      mcpServers: {},
      settingSources: [],
      env: context.env,
      pathToClaudeCodeExecutable: resolveClaudeExecutable(),
    }),
    prompt: request.prompt,
    ...("system" in request && request.system !== undefined ? { system: request.system } : {}),
    ...(context.output === undefined ? {} : { output: context.output }),
  });
}

export const claudeDriver = {
  kind: "claude",
  family: "harness",
  run,
  ask,
  runtimeChecks: () => [harnessRuntimeCheck("claude")],
  authChecks: () => [claudeAuthCheck()],
  envAllowlist: () => [],
  sessionPointer: { providerKey: "claude-code", field: "sessionId" },
  docsAnchor: "claude-code",
  displayName: "Claude Code",
  resolveExecutable: resolveClaudeExecutable,
} satisfies Driver<"claude">;
