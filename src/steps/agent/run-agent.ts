// The step side of runAgent(): what the factory's "use step" wrapper delegates
// to. Runs the JIT checks, hydrates live providers from wire config (nothing
// live crossed the boundary), and normalizes the generation into the uniform
// AgentStepResult.
//
// Everything here reaches node builtins, so this module must only ever be
// imported from inside a step body — a workflow-side import of it fails the
// build loudly, which is the point of keeping it out of blocks/.

import { generateText, jsonSchema, type LanguageModel, Output, type OutputInterface } from "ai";
import type { McpServerConfig as ClaudeMcpServerConfig } from "ai-sdk-provider-claude-code";
import type { CodexExecSettings } from "ai-sdk-provider-codex-cli";
// Type-only, so it is erased and no workflow-side module is pulled in here.
// The wrapper type is the one declaration of what crosses the step boundary.
import type { ExecuteAgentStep } from "../../blocks/agent/agent.ts";
import type { McpServerConfig } from "../../blocks/agent/harness-config.ts";
import type { AgentWire } from "../../blocks/agent/plan.ts";
import {
  type AgentStepResult,
  extractAgentSession,
  type StepGeneration,
  toStepResult,
} from "../../blocks/agent/result.ts";
import {
  type FailedCheck,
  failedChecks,
  JIT_TIMEOUT_MS,
  jitChecks,
  runChecks,
} from "../../checks/index.ts";
import type { RunMetadata } from "../run-context.ts";
import { claudeStepSettings } from "./harnesses/claude.ts";
import { codexAppServerStepSettings, withCodexAppServer } from "./harnesses/codex.ts";
import { ensureManagedCodexHome } from "./harnesses/codex-home.ts";
import { scrubbedEnv } from "./harnesses/env.ts";
import { claudeCode } from "./harnesses/index.ts";
import { FileLockTimeoutError, lockPathFor, withFileLock } from "./lock.ts";

// Exported for ./run-ask.ts, which shares the executor seam; not part of the
// ./steps/run subpath.
export type ExecutorGeneration = StepGeneration & { output?: unknown };

// The provider declares but does not export its MCP config type.
type CodexMcpServerConfig = NonNullable<CodexExecSettings["mcpServers"]>[string];

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
  ensureCodexHome(runId: string): string;
  withCodexAppServer: typeof withCodexAppServer;
  // Seamed like the harness calls beside it: a test hydrating a wire that
  // declares MCP servers must not spawn them.
  jitFailures(wire: AgentWire): Promise<FailedCheck[] | undefined>;
}

export const realDeps: ExecuteDeps = {
  generateText: (options) => generateText(options),
  ensureCodexHome: (runId) => ensureManagedCodexHome(runId),
  withCodexAppServer,
  jitFailures: async (wire) => {
    const report = await runChecks(jitChecks(wire), JIT_TIMEOUT_MS);
    return report.ok ? undefined : failedChecks(report);
  },
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
            ...(server.headers !== undefined ? { headers: server.headers } : {}),
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
            ...(server.headers !== undefined ? { httpHeaders: server.headers } : {}),
          };
  }
  return mapped;
}

// Exported for ./run-ask.ts, which builds the same output spec; not part of
// the ./steps/run subpath.
export function outputSpec(
  schema: Record<string, unknown> | undefined,
): OutputInterface<unknown, unknown, never> | undefined {
  return schema === undefined ? undefined : Output.object({ schema: jsonSchema<unknown>(schema) });
}

// graphile-worker's 4h job expiry is the last thing that can redeliver a step,
// so the lock a takeover guard holds has to outlast it.
const LOCK_STALE_MS = 4 * 60 * 60_000 + 60_000;

/** Run an agent in its worktree, checking required tools before it starts. */
export async function executeAgent(
  wire: AgentWire,
  metadata: RunMetadata,
  deps: ExecuteDeps = realDeps,
): ReturnType<ExecuteAgentStep> {
  const runId = metadata.workflowRunId;
  // JIT checks first — this is the last honest moment before agent turns
  // get burned, and the servers only exist now that the body built them.
  const jitFailure = await deps.jitFailures(wire);
  // Returned, not thrown: a failed step's rejection is rebuilt from its
  // message, and a value is not a step failure, so no retries either.
  if (jitFailure !== undefined) return { jitFailure };

  // A pointer recorded on the other harness cannot name a session here. It
  // reports as the same unusable-session marker a stale pointer does, so the
  // one fresh-context fallback covers both and no caller re-checks the kind.
  if (wire.resume !== undefined && wire.resume.harness !== wire.harness.kind) {
    return {
      resumeFailed: `session ${wire.resume.id} was recorded on the ${wire.resume.harness} harness and this step runs on ${wire.harness.kind}`,
    };
  }

  // One agent per worktree, always. The World re-queues a step whose
  // HTTP dispatch was cut short while the step itself is still running, and
  // workflow@4.8.4 neither cancels the first execution nor dedupes the second —
  // two agents in one worktree is a state its data model permits. This advisory
  // lock is what forbids it. Fail-fast rather than queue: a second agent that
  // waited its turn would only corrupt the worktree later.
  try {
    return await withFileLock(
      lockPathFor(wire.cwd, "agent-step"),
      () => generateAgentStep(wire, runId, deps),
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
  runId: string,
  deps: ExecuteDeps,
): Promise<AgentStepResult<unknown> | { resumeFailed: string }> {
  const harness = wire.harness;
  const env = scrubbedEnv();
  const output = outputSpec(wire.outputSchema);
  const request = {
    prompt: wire.prompt,
    ...(output !== undefined ? { output } : {}),
  };
  // Kind-checked by executeAgent before the lock; anything left here names this
  // harness.
  const resume = wire.resume;

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
                  codexHome: deps.ensureCodexHome(runId),
                  env,
                  approvalPolicy: "never",
                  // Unsandboxed on purpose: a jigs worktree's real git dir
                  // lives in the main checkout's .git/worktrees/<name>/,
                  // outside the workspace, so workspace-write fails every
                  // commit on a read-only index lock. Same trust level the
                  // claude path already runs at.
                  sandboxPolicy: "danger-full-access",
                  autoApprove: true,
                  ...(harness.mcpServers !== undefined
                    ? { mcpServers: toCodexMcpServers(harness.mcpServers) }
                    : {}),
                }),
              ),
              ...request,
              // The provider prefers this field over settings.resume — an
              // explicit id takes the resume path.
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

  const session = extractAgentSession(harness.kind, generation.providerMetadata);
  return {
    ...toStepResult(generation, wire.outputSchema !== undefined ? generation.output : undefined),
    ...(session !== undefined ? { session } : {}),
  };
}
