import type { AsyncLocalStorage } from "node:async_hooks";
import type { TextStreamPart, ToolSet } from "ai";
import { getStepMetadata, getWritable } from "workflow";
import type { HarnessKind } from "../../workflow/agents/harness-config.ts";

/** One record in an agent step's Workflow stream, as the dashboard shows it. */
export type AgentStreamPart =
  | { type: "attempt-start"; attempt: number; harness: HarnessKind; cwd: string; resume: boolean }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: string; isError: boolean }
  | { type: "finish"; finishReason: string }
  | { type: "error"; message: string };

export interface StepStream {
  attempt: number;
  writable: WritableStream<AgentStreamPart>;
}

export type AttemptStart = Omit<
  Extract<AgentStreamPart, { type: "attempt-start" }>,
  "type" | "attempt"
>;

const COALESCE_MS = 1000;
const PAYLOAD_CAP = 4096;

// Symbol.for global the Workflow SDK keeps its step context under.
const STEP_CONTEXT = Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE");

/**
 * The current step's stream, namespaced by its step id, or undefined outside a step.
 *
 * @remarks
 * The SDK awaits every stream a step opened before it completes the step, and
 * fails the step when a flush fails or takes over 30 seconds. The writable is
 * opened under a copy of the step context with its own pending-op list, so the
 * flush runs in the background and a broken stream never fails the agent step.
 */
export function openStepStream(): StepStream | undefined {
  try {
    const storage = (globalThis as Record<symbol, AsyncLocalStorage<object> | undefined>)[
      STEP_CONTEXT
    ];
    const context = storage?.getStore();
    if (storage === undefined || context === undefined) return undefined;
    const { stepId, attempt } = getStepMetadata();
    const detached = { ...context, ops: [], streamStates: undefined, writables: undefined };
    const writable = storage.run(detached, () =>
      getWritable<AgentStreamPart>({ namespace: stepId }),
    );
    return { attempt, writable };
  } catch {
    return undefined;
  }
}

/**
 * Read a `streamText` run to its end, writing coalesced parts to the step
 * stream, and throw the provider's error the way `generateText` would.
 */
export async function teeAgentStream(
  parts: AsyncIterable<TextStreamPart<ToolSet>>,
  stream: StepStream | undefined,
  start: AttemptStart,
  now: () => number = Date.now,
): Promise<void> {
  const sink = openSink(stream);
  let pending: { type: "text" | "reasoning"; text: string; since: number } | undefined;
  const flush = () => {
    if (pending !== undefined && pending.text !== "") {
      sink.write({ type: pending.type, text: pending.text });
    }
    pending = undefined;
  };
  try {
    if (stream !== undefined)
      sink.write({ type: "attempt-start", attempt: stream.attempt, ...start });
    for await (const part of parts) {
      if (part.type === "text-delta" || part.type === "reasoning-delta") {
        const type = part.type === "text-delta" ? "text" : "reasoning";
        if (pending?.type !== type) {
          flush();
          pending = { type, text: "", since: now() };
        }
        pending.text += part.text;
        if (now() - pending.since >= COALESCE_MS) flush();
        continue;
      }
      if (part.type === "error") throw part.error;
      const record = recordOf(part);
      if (record === undefined) continue;
      flush();
      sink.write(record);
    }
    flush();
  } catch (error) {
    flush();
    sink.write({ type: "error", message: truncate(errorMessage(error)) });
    throw error;
  } finally {
    sink.release();
  }
}

function recordOf(part: TextStreamPart<ToolSet>): AgentStreamPart | undefined {
  switch (part.type) {
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: truncate(part.input),
      };
    case "tool-result":
      return {
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: truncate(part.output),
        isError: false,
      };
    case "tool-error":
      return {
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: truncate(errorMessage(part.error)),
        isError: true,
      };
    case "finish":
      return { type: "finish", finishReason: part.finishReason };
    default:
      return undefined;
  }
}

// Writes are never awaited, so a slow World cannot slow the agent, and the
// first failure turns the rest of the attempt's writes off.
function openSink(stream: StepStream | undefined): {
  write(part: AgentStreamPart): void;
  release(): void;
} {
  let writer: WritableStreamDefaultWriter<AgentStreamPart> | undefined;
  try {
    writer = stream?.writable.getWriter();
  } catch {
    writer = undefined;
  }
  let live = writer !== undefined;
  const disable = () => {
    live = false;
  };
  return {
    write(part) {
      if (!live || writer === undefined) return;
      try {
        writer.write(part).catch(disable);
      } catch {
        disable();
      }
    },
    release() {
      live = false;
      try {
        writer?.releaseLock();
      } catch {}
    },
  };
}

function truncate(value: unknown): string {
  const text = typeof value === "string" ? value : stringify(value);
  if (text.length <= PAYLOAD_CAP) return text;
  return `${text.slice(0, PAYLOAD_CAP)}… [truncated ${text.length - PAYLOAD_CAP} chars]`;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
