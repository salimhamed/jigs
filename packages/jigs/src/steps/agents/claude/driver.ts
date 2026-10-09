import { createHash, randomUUID } from "node:crypto";
import {
  type McpServerConfig as ClaudeMcpServerConfig,
  deleteSession,
  getSessionMessages,
  type Options,
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { JigsError } from "../../../errors.ts";
import type { TurnRequest, TurnResult } from "../../../workflow/agents/conversation.ts";
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
import { claudeGeneration, claudeStreamParts, resultOutcome } from "./messages.ts";
import { CLAUDE_ENV, type ClaudeProcessSpawner, claudeStepSettings } from "./process.ts";
import { accepting, startTurn, step, type TurnAction, type TurnInput } from "./turn-state.ts";

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
  close(): void;
};

export interface ClaudeDriverDependencies {
  query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }): ClaudeQuery;
  /** The uuids of every message in a session's transcript; empty when there is none. */
  transcript(sessionId: string, cwd: string): Promise<ReadonlySet<string>>;
  /** Remove a session's files, if it has any. */
  discardSession(sessionId: string, cwd: string): Promise<void>;
  prepareSkillsPlugin(runId: string, skills: readonly string[]): Promise<SkillsPlugin>;
  openStepStream(): StepStream | undefined;
}

const defaultDependencies: ClaudeDriverDependencies = {
  query,
  transcript: async (sessionId, cwd) =>
    new Set(
      (await getSessionMessages(sessionId, { dir: cwd, includeSystemMessages: true })).map(
        (message) => message.uuid,
      ),
    ),
  // Throws when there is no session to remove, which is the usual case.
  discardSession: (sessionId, cwd) => deleteSession(sessionId, { dir: cwd }).catch(() => {}),
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

// How long a stopped turn waits for Claude Code to confirm the interrupt before closing it.
// Shorter than the service's 30 s stop fallback, so the run ends the turn before it is cancelled.
const STOP_GRACE_MS = 15_000;

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
    if (resume !== undefined && (await deps.transcript(resume.id, cwd)).size === 0) {
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
    const opened = startTurn({
      messages: request.messages,
      transcript: await deps.transcript(sessionId, cwd),
      instructions: request.instructions,
      note: randomUUID(),
    });
    // A session file without messages, such as one left by a Claude Code killed while it
    // started, would refuse a fresh start under the same id on every retry.
    if (!opened.state.resume) await deps.discardSession(sessionId, cwd);

    const input = inputQueue();
    let plugin: SkillsPlugin | undefined;
    let settings: ReturnType<typeof workSettings> | undefined;
    let active: ClaudeQuery | undefined;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    let unregister = () => {};
    let finish!: (result: TurnResult) => void;
    let fail!: (error: unknown) => void;
    const outcome = new Promise<TurnResult>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });

    let state = opened.state;
    // Observers and the live turn call back in while actions run; each input sees the latest state.
    const dispatch = (event: TurnInput): void => {
      const next = step(state, event);
      state = next.state;
      for (const action of next.actions) perform(action);
    };
    const perform = (action: TurnAction): void => {
      switch (action.type) {
        case "send":
          input.push(userMessage(action.uuid, action.text));
          return;
        case "launch":
          settings = workSettings(
            harness,
            cwd,
            context,
            plugin,
            state.resume ? { resume: sessionId } : { sessionId },
          );
          active = deps.query({ prompt: input.messages(), options: settings });
          void read(active);
          return;
        case "interrupt":
          void active?.interrupt({ cancelQueued: true }).then(
            (receipt) => dispatch({ type: "receipt", cancelled: receipt?.cancelled }),
            () => dispatch({ type: "interrupt-failed" }),
          );
          return;
        case "start-backstop":
          backstop = setTimeout(() => dispatch({ type: "backstop" }), STOP_GRACE_MS);
          return;
        case "observe":
          context.observe(action.event);
          return;
        case "close":
          unregister();
          input.close();
          return;
        case "finish":
          finish(action.result);
          return;
        case "rethrow":
          fail(action.error);
          return;
      }
    };
    const read = async (query: ClaudeQuery) => {
      const parts = claudeStreamParts();
      try {
        for await (const message of query) {
          if (state.phase === "ended") return;
          for (const part of parts(message)) context.observe({ type: "part", part });
          if (message.type === "assistant") dispatch({ type: "assistant", error: message.error });
          if (message.type === "result") {
            dispatch({
              type: "result",
              uuids: message.user_message_uuids,
              ...resultOutcome(message),
            });
          }
        }
        throw new Error("Claude Code ended without a result");
      } catch (error) {
        dispatch({ type: "crashed", error, cancelled: context.signal.aborted });
      }
    };

    for (const action of opened.actions) perform(action);
    try {
      unregister = registerLiveTurn(conversation, {
        inject: (message) => {
          const taken = accepting(state);
          dispatch({ type: "inject", message });
          return taken;
        },
        stop: () => dispatch({ type: "stop", withdrawn: input.drop().map(uuidOf) }),
      });
      if (harness.skills !== undefined && harness.skills.length > 0) {
        plugin = await deps.prepareSkillsPlugin(context.metadata.workflowRunId, harness.skills);
      }
      context.observe({ type: "start", resume: state.resume });
      dispatch({ type: "launch" });
      return await outcome;
    } finally {
      clearTimeout(backstop);
      unregister();
      input.close();
      active?.close();
      await settings?.spawnClaudeCodeProcess.close();
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
