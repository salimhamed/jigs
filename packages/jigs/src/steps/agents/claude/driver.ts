import { createHash, randomUUID } from "node:crypto";
import {
  type McpServerConfig as ClaudeMcpServerConfig,
  getSessionMessages,
  type Options,
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { JigsError } from "../../../errors.ts";
import type {
  ConversationMessage,
  TurnReply,
  TurnRequest,
  TurnResult,
} from "../../../workflow/agents/conversation.ts";
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
import { registerLiveTurn } from "../shared/live-turns.ts";
import { mcpCredentialVariables, resolveMcpServer } from "../shared/mcp-credentials.ts";
import { AgentSessionError } from "../shared/session-error.ts";
import {
  claudePluginsPath,
  prepareClaudeSkillsPlugin,
  type SkillsPlugin,
} from "../shared/skills.ts";
import { createStreamTap, openStepStream, type StepStream } from "../shared/step-stream.ts";
import type {
  ConverseContext,
  Driver,
  DriverContext,
  DriverRequest,
  ExecutorGeneration,
  RunRequest,
} from "../shared/types.ts";
import { claudeAuthCheck } from "./checks.ts";
import { claudeGeneration, claudeStreamParts } from "./messages.ts";
import { CLAUDE_ENV, type ClaudeProcessSpawner, claudeStepSettings } from "./process.ts";

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

function descriptor(request: DriverRequest | TurnRequest): ClaudeHarness {
  if (!("harness" in request) || request.harness.kind !== "claude") {
    throw new JigsError("the Claude driver requires a Claude request");
  }
  return request.harness;
}

/** The parts of the SDK's `Query` the driver uses. */
export type ClaudeQuery = AsyncIterable<SDKMessage> & {
  // The CLI honours cancelQueued; the SDK's types leave the parameter out.
  interrupt(options?: { cancelQueued?: boolean }): Promise<{ cancelled?: string[] } | undefined>;
};

export interface ClaudeDriverDependencies {
  query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }): ClaudeQuery;
  sessionMessages(sessionId: string, cwd: string): Promise<readonly unknown[]>;
  /** The uuids of every message in a session's transcript; empty when there is none. */
  transcript(sessionId: string, cwd: string): Promise<ReadonlySet<string>>;
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
  transcript: async (sessionId, cwd) =>
    new Set(
      (await getSessionMessages(sessionId, { dir: cwd, includeSystemMessages: true })).map(
        (message) => message.uuid,
      ),
    ),
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

// What `run` and `converse` share: the descriptor's policy, the worktree, MCP and skills.
function workSettings(
  harness: ClaudeHarness,
  cwd: string,
  context: DriverContext,
  plugin: SkillsPlugin | undefined,
  session: Pick<Options, "resume" | "sessionId" | "outputFormat">,
): Options & { spawnClaudeCodeProcess: ClaudeProcessSpawner } {
  const disallowed = disallowedTools(harness);
  return claudeStepSettings({
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
    ...session,
    ...(harness.mcpServers === undefined
      ? {}
      : { mcpServers: mcpServers(harness.mcpServers, context.env) }),
    ...(plugin === undefined
      ? {}
      : { plugins: [{ type: "local", path: plugin.path, skipMcpDiscovery: true }] }),
  });
}

/** What Claude is told when it resumes a turn the service died during. */
export const RESTART_NOTE =
  "The service restarted during this turn. Check where you got to and carry on.";

/** The Claude session a conversation holds: a UUID derived from its name. */
export function conversationSessionId(conversation: string): string {
  const hex = createHash("sha256").update(`jigs.conversation:${conversation}`).digest("hex");
  // Shaped as a version 8 (custom) UUID, which Claude Code accepts as a session id.
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function userMessage(uuid: string, text: string): SDKUserMessage {
  // The SDK passes `uuid` through to the CLI, which echoes it in `user_message_uuids`.
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid,
  } as SDKUserMessage;
}

const uuidOf = (message: SDKUserMessage) => (message as { uuid: string }).uuid;

const authored = (message: ConversationMessage) => `${message.author}: ${message.text}`;

/** An input stream Claude reads from while the driver keeps adding to it. */
function inputQueue() {
  const queued: SDKUserMessage[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  return {
    push(message: SDKUserMessage) {
      queued.push(message);
      wake?.();
    },
    /** Take back what Claude has not read yet, returning it. */
    drop(): SDKUserMessage[] {
      return queued.splice(0);
    },
    close() {
      closed = true;
      wake?.();
    },
    async *messages(): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        const next = queued.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
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
      const settings = workSettings(harness, cwd, context, plugin, {
        ...(resume === undefined ? {} : { resume: resume.id }),
        ...outputFormat(request.outputSchema),
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

  async function converse(request: TurnRequest, context: ConverseContext): Promise<TurnResult> {
    const harness = descriptor(request);
    const { cwd, conversation } = request;
    const sessionId = conversationSessionId(conversation);
    const transcript = await deps.transcript(sessionId, cwd);
    const resume = transcript.size > 0;

    const input = inputQueue();
    // Sent and not yet named by any result.
    const pending = new Set<string>();
    // The caller's messages this turn has taken, delivered or not.
    const accepted = new Set(request.messages.map((message) => message.uuid));
    const consumed = request.messages
      .filter((message) => transcript.has(message.uuid))
      .map((message) => message.uuid);
    const replies: TurnReply[] = [];
    let ending = false;
    let stopped = false;
    let active: ClaudeQuery | undefined;
    const send = (uuid: string, text: string) => {
      pending.add(uuid);
      input.push(userMessage(uuid, text));
    };

    // A turn that died after Claude took its message goes on from the transcript, never redone.
    if (consumed.length > 0) send(randomUUID(), RESTART_NOTE);
    let lead = resume || request.instructions === undefined ? undefined : request.instructions;
    for (const message of request.messages) {
      if (transcript.has(message.uuid)) continue;
      send(
        message.uuid,
        lead === undefined ? authored(message) : `${lead}\n\n${authored(message)}`,
      );
      lead = undefined;
    }

    const unregister = registerLiveTurn(conversation, {
      inject(message) {
        if (ending || stopped) return false;
        if (accepted.has(message.uuid)) return true;
        accepted.add(message.uuid);
        send(message.uuid, authored(message));
        return true;
      },
      stop() {
        if (ending || stopped) return;
        stopped = true;
        // Unread messages would reach Claude after the interrupt and run as a new turn.
        for (const dropped of input.drop()) pending.delete(uuidOf(dropped));
        // An interrupt with no turn running would land on the next one instead.
        if (active === undefined || pending.size === 0) return;
        void active.interrupt({ cancelQueued: true }).then(
          (receipt) => {
            for (const uuid of receipt?.cancelled ?? []) pending.delete(uuid);
          },
          () => {},
        );
      },
    });
    // Nothing reaches Claude once the turn is ending: a message sent to a closing CLI is lost.
    const end = () => {
      ending = true;
      unregister();
      input.close();
    };

    const plugin =
      harness.skills === undefined || harness.skills.length === 0
        ? undefined
        : await deps
            .prepareSkillsPlugin(context.metadata.workflowRunId, harness.skills)
            .catch((error: unknown) => {
              end();
              throw error;
            });
    try {
      context.observe({ type: "start", resume });
      if (stopped) return { outcome: "stopped", replies, consumed };
      const settings = workSettings(
        harness,
        cwd,
        context,
        plugin,
        resume ? { resume: sessionId } : { sessionId },
      );
      try {
        const parts = claudeStreamParts();
        let errorKind: string | undefined;
        active = deps.query({ prompt: input.messages(), options: settings });
        for await (const message of active) {
          for (const part of parts(message)) context.observe({ type: "part", part });
          if (message.type === "assistant") errorKind = message.error;
          if (message.type !== "result") continue;
          const answered = (message.user_message_uuids ?? []).filter(
            (uuid) => pending.delete(uuid) && accepted.has(uuid),
          );
          consumed.push(...answered);
          // An interrupted turn ends in an error result; a stop is not a failure.
          const reply =
            stopped && (message.subtype !== "success" || message.is_error)
              ? undefined
              : { text: claudeGeneration(message, false, errorKind).text, consumed: answered };
          errorKind = undefined;
          const done = stopped || pending.size === 0;
          if (done) end();
          if (reply !== undefined) {
            replies.push(reply);
            context.observe({ type: "reply", reply });
          }
          if (done) break;
        }
        if (!ending && !stopped) throw new Error("Claude Code ended without a result");
        return { outcome: stopped ? "stopped" : "finished", replies, consumed };
      } finally {
        await settings.spawnClaudeCodeProcess.close();
      }
    } finally {
      end();
      plugin?.cleanup();
    }
  }

  const driver: Driver<"claude"> = {
    family: "harness",
    ask,
    run,
    converse,
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
