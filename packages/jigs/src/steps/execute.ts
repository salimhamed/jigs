// Step-side execution: hydrates live providers from wire config (ADR 0008 —
// nothing live crossed the boundary) and normalizes the generation into the
// uniform StepResult. Runs inside a "use step" function, so node imports and
// process.env are fair game here.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  generateText,
  jsonSchema,
  type LanguageModel,
  Output,
  type OutputInterface,
} from "ai";
import type { McpServerConfig as ClaudeMcpServerConfig } from "ai-sdk-provider-claude-code";
import type { CodexExecSettings } from "ai-sdk-provider-codex-cli";
import {
  claudeStepSettings,
  resolveClaudeExecutable,
} from "../harnesses/claude.ts";
import {
  codexAppServerStepSettings,
  codexExecStepSettings,
  withCodexAppServer,
} from "../harnesses/codex.ts";
import { ensureManagedCodexHome } from "../harnesses/codex-home.ts";
import { stripApiCredentials } from "../harnesses/env.ts";
import { claudeCode, codexExec } from "../harnesses/index.ts";
import type { HarnessConfig, McpServerConfig } from "./config.ts";
import type { AgentWire, AskWire } from "./plan.ts";
import {
  type AgentStepResult,
  extractAgentSession,
  type StepGeneration,
  type StepResult,
  toStepResult,
} from "./result.ts";

type ExecutorGeneration = StepGeneration & { output?: unknown };

// The provider declares but does not export its MCP config type.
type CodexMcpServerConfig = NonNullable<
  CodexExecSettings["mcpServers"]
>[string];

export interface ExecuteDeps {
  generateText(options: {
    model: LanguageModel;
    prompt: string;
    system?: string;
    output?: OutputInterface<unknown, unknown, never>;
  }): Promise<ExecutorGeneration>;
  ensureCodexHome(runKey: string): string;
  withCodexAppServer: typeof withCodexAppServer;
}

export const realDeps: ExecuteDeps = {
  generateText: (options) => generateText(options),
  ensureCodexHome: (runKey) => ensureManagedCodexHome(runKey),
  withCodexAppServer,
};

function scrubbedEnv(): Record<string, string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  stripApiCredentials(env);
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

function toClaudeMcpServers(
  servers: Record<string, McpServerConfig>,
): Record<string, ClaudeMcpServerConfig> {
  const mapped: Record<string, ClaudeMcpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    mapped[name] =
      "command" in server
        ? {
            type: "stdio",
            command: server.command,
            ...(server.args !== undefined ? { args: server.args } : {}),
            ...(server.env !== undefined ? { env: server.env } : {}),
          }
        : {
            type: "http",
            url: server.url,
            ...(server.headers !== undefined
              ? { headers: server.headers }
              : {}),
          };
  }
  return mapped;
}

function toCodexMcpServers(
  servers: Record<string, McpServerConfig>,
): Record<string, CodexMcpServerConfig> {
  const mapped: Record<string, CodexMcpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    mapped[name] =
      "command" in server
        ? {
            transport: "stdio",
            command: server.command,
            ...(server.args !== undefined ? { args: server.args } : {}),
            ...(server.env !== undefined ? { env: server.env } : {}),
          }
        : {
            transport: "http",
            url: server.url,
            ...(server.headers !== undefined
              ? { httpHeaders: server.headers }
              : {}),
          };
  }
  return mapped;
}

function outputSpec(
  schema: Record<string, unknown> | undefined,
): OutputInterface<unknown, unknown, never> | undefined {
  return schema === undefined
    ? undefined
    : Output.object({ schema: jsonSchema<unknown>(schema) });
}

export async function executeAgentStep(
  wire: AgentWire,
  runKey: string,
  deps: ExecuteDeps = realDeps,
): Promise<AgentStepResult<unknown>> {
  const harness = wire.harness;
  const env = scrubbedEnv();
  const output = outputSpec(wire.outputSchema);

  const generation =
    harness.kind === "claude"
      ? await deps.generateText({
          model: claudeCode(
            harness.model,
            claudeStepSettings({
              cwd: wire.cwd,
              env,
              ...(wire.permissionMode !== undefined
                ? { permissionMode: wire.permissionMode }
                : {}),
              ...(harness.mcpServers !== undefined
                ? { mcpServers: toClaudeMcpServers(harness.mcpServers) }
                : {}),
            }),
          ),
          prompt: wire.prompt,
          ...(wire.instructions !== undefined
            ? { system: wire.instructions }
            : {}),
          ...(output !== undefined ? { output } : {}),
        })
      : await deps.withCodexAppServer((provider) =>
          deps.generateText({
            model: provider(
              harness.model,
              // App-server, not exec: only persistent threads yield the
              // threadId session pointer and the rollouts a resuming
              // builder needs.
              codexAppServerStepSettings({
                cwd: wire.cwd,
                codexHome: deps.ensureCodexHome(runKey),
                env,
                approvalPolicy: "never",
                sandboxPolicy: "workspace-write",
                autoApprove: true,
                ...(harness.mcpServers !== undefined
                  ? { mcpServers: toCodexMcpServers(harness.mcpServers) }
                  : {}),
              }),
            ),
            prompt: wire.prompt,
            ...(wire.instructions !== undefined
              ? { system: wire.instructions }
              : {}),
            ...(output !== undefined ? { output } : {}),
          }),
        );

  return {
    ...toStepResult(
      generation,
      wire.outputSchema !== undefined ? generation.output : undefined,
    ),
    ...sessionOf(harness, generation),
  };
}

function sessionOf(
  harness: HarnessConfig,
  generation: ExecutorGeneration,
): Pick<AgentStepResult, "session"> {
  const session = extractAgentSession(
    harness.kind,
    generation.providerMetadata,
  );
  return session === undefined ? {} : { session };
}

export async function executeAskStep(
  wire: AskWire,
  runKey: string,
  deps: ExecuteDeps = realDeps,
): Promise<StepResult<unknown>> {
  const harness = wire.harness;
  const env = scrubbedEnv();
  const output = outputSpec(wire.outputSchema);

  let generation: ExecutorGeneration;
  if (harness.kind === "claude") {
    generation = await deps.generateText({
      // Not claudeStepSettings: a plain model call loads no worktree
      // settings and sees no MCP universe at all.
      model: claudeCode(harness.model, {
        strictMcpConfig: true,
        mcpServers: {},
        settingSources: [],
        env,
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      }),
      prompt: wire.prompt,
      ...(wire.system !== undefined ? { system: wire.system } : {}),
      ...(output !== undefined ? { output } : {}),
    });
  } else {
    // codex exec needs a cwd even for a pure model call; a scratch tmp dir
    // keeps a read-only sandbox pointed away from anything real.
    const scratch = mkdtempSync(path.join(tmpdir(), "jigs-ask-"));
    try {
      generation = await deps.generateText({
        model: codexExec(
          harness.model,
          codexExecStepSettings({
            cwd: scratch,
            codexHome: deps.ensureCodexHome(runKey),
            env,
            approvalMode: "never",
            sandboxMode: "read-only",
          }),
        ),
        prompt: wire.prompt,
        ...(wire.system !== undefined ? { system: wire.system } : {}),
        ...(output !== undefined ? { output } : {}),
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  return toStepResult(
    generation,
    wire.outputSchema !== undefined ? generation.output : undefined,
  );
}
