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
import { scrubbedEnv } from "../harnesses/env.ts";
import { claudeCode, codexExec } from "../harnesses/index.ts";
import {
  FileLockTimeoutError,
  lockPathFor,
  withFileLock,
} from "../worktrees/lock.ts";
import type { McpServerConfig } from "./config.ts";
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
    // Narrow on purpose: the only value jigs ever passes here is a Codex
    // thread id.
    providerOptions?: Record<string, Record<string, string>>;
  }): Promise<ExecutorGeneration>;
  ensureCodexHome(runKey: string): string;
  withCodexAppServer: typeof withCodexAppServer;
}

export const realDeps: ExecuteDeps = {
  generateText: (options) => generateText(options),
  ensureCodexHome: (runKey) => ensureManagedCodexHome(runKey),
  withCodexAppServer,
};

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

// graphile-worker's 4h job expiry is the last thing that can redeliver a step,
// so the lock a takeover guard holds has to outlast it.
const LOCK_STALE_MS = 4 * 60 * 60_000 + 60_000;

// One agent per worktree, always. The World re-queues a step whose
// HTTP dispatch was cut short while the step itself is still running, and
// workflow@4.8.4 neither cancels the first execution nor dedupes the second —
// two agents in one worktree is a state its data model permits. This advisory
// lock is what forbids it. Fail-fast rather than queue: a second agent that
// waited its turn would only corrupt the worktree later.
export async function executeAgentStep(
  wire: AgentWire,
  runKey: string,
  deps: ExecuteDeps = realDeps,
): Promise<AgentStepResult<unknown> | { resumeFailed: string }> {
  try {
    return await withFileLock(
      lockPathFor(wire.cwd, "agent-step"),
      () => generateAgentStep(wire, runKey, deps),
      { timeoutMs: 0, staleMs: LOCK_STALE_MS },
    );
  } catch (err) {
    if (err instanceof FileLockTimeoutError) {
      throw new Error(
        `an agent is already running in ${wire.cwd} — refusing to start a second one in the same worktree`,
      );
    }
    throw err;
  }
}

async function generateAgentStep(
  wire: AgentWire,
  runKey: string,
  deps: ExecuteDeps,
): Promise<AgentStepResult<unknown> | { resumeFailed: string }> {
  const harness = wire.harness;
  const env = scrubbedEnv();
  const output = outputSpec(wire.outputSchema);
  const request = {
    prompt: wire.prompt,
    ...(wire.instructions !== undefined ? { system: wire.instructions } : {}),
    ...(output !== undefined ? { output } : {}),
  };
  // A pointer recorded on the other harness cannot name a session here, so it
  // is ignored rather than refused: the step starts fresh.
  const resume =
    wire.resume?.harness === harness.kind ? wire.resume : undefined;

  let generation: ExecutorGeneration;
  try {
    generation =
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
                // The provider gates bypassPermissions behind this paired
                // flag; passing the mode is the consent.
                ...(wire.permissionMode === "bypassPermissions"
                  ? { allowDangerouslySkipPermissions: true }
                  : {}),
                ...(resume !== undefined ? { resume: resume.id } : {}),
                ...(harness.mcpServers !== undefined
                  ? { mcpServers: toClaudeMcpServers(harness.mcpServers) }
                  : {}),
              }),
            ),
            ...request,
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
                  // Unsandboxed on purpose (AGE-359): a jigs worktree's real
                  // git dir lives in the main checkout's
                  // .git/worktrees/<name>/, outside the workspace, so
                  // workspace-write fails every commit on a read-only index
                  // lock. Same trust level the claude path already runs at.
                  sandboxPolicy: "danger-full-access",
                  autoApprove: true,
                  ...(harness.mcpServers !== undefined
                    ? { mcpServers: toCodexMcpServers(harness.mcpServers) }
                    : {}),
                }),
              ),
              ...request,
              // ADR 0004's amendment names this field, and the provider
              // prefers it over settings.resume — an explicit id takes the
              // resume path.
              ...(resume !== undefined
                ? {
                    providerOptions: {
                      "codex-app-server": { threadId: resume.id },
                    },
                  }
                : {}),
            }),
          );
  } catch (err) {
    if (resume === undefined) throw err;
    // Returned, not thrown: workflow@4.8.4 retries a rejected step three times
    // by default, so a session that is simply gone would burn three paid
    // attempts before the fresh-context fallback ever ran. Any error is
    // staleness — codex 0.149.1 reports it as a raw JSON-RPC "no rollout found
    // for thread id", which escapes the provider's own not-found wrapper, so
    // there is no error string worth matching on.
    return { resumeFailed: String(err) };
  }

  const session = extractAgentSession(
    harness.kind,
    generation.providerMetadata,
  );
  return {
    ...toStepResult(
      generation,
      wire.outputSchema !== undefined ? generation.output : undefined,
    ),
    ...(session !== undefined ? { session } : {}),
  };
}

export async function executeAskStep(
  wire: AskWire,
  runKey: string,
  deps: ExecuteDeps = realDeps,
): Promise<StepResult<unknown>> {
  const harness = wire.harness;
  const env = scrubbedEnv();
  const output = outputSpec(wire.outputSchema);
  const request = {
    prompt: wire.prompt,
    ...(wire.system !== undefined ? { system: wire.system } : {}),
    ...(output !== undefined ? { output } : {}),
  };

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
      ...request,
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
        ...request,
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
