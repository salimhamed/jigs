import {
  type AgentSourcePart,
  type AttemptStart,
  createStreamTap,
  type StepStream,
} from "../shared/step-stream.ts";

/** Observe Pi's JSONL output without participating in its result reduction. */
export function createPiStreamTap(stream: StepStream, start: AttemptStart) {
  const tap = createStreamTap(stream, start);
  let pending = "";
  const write = (chunk: string) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      try {
        for (const part of partsOf(JSON.parse(line))) tap.write(part);
      } catch {
        // Bad lines still reach the full-buffer reducer, which reports them.
      }
    }
  };
  return {
    write,
    async end(error?: unknown) {
      write("\n");
      await tap.end(error);
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function* partsOf(value: unknown): Generator<AgentSourcePart> {
  const event = record(value);
  const delta = record(event.assistantMessageEvent);
  if (event.type === "message_update" && typeof delta.delta === "string") {
    if (delta.type === "text_delta" || delta.type === "thinking_delta") {
      yield {
        type: delta.type === "text_delta" ? "text-delta" : "reasoning-delta",
        text: delta.delta,
      };
    }
  }
  // A completed assistant message has the full arguments, unlike toolcall_delta.
  // Ignore tool_execution_start so each call appears exactly once.
  const message = record(event.message);
  if (
    event.type === "message_end" &&
    message.role === "assistant" &&
    Array.isArray(message.content)
  ) {
    for (const item of message.content) {
      const call = record(item);
      if (
        call.type === "toolCall" &&
        typeof call.id === "string" &&
        typeof call.name === "string"
      ) {
        yield {
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.name,
          input: call.arguments,
        };
      }
    }
  }
  if (
    event.type === "tool_execution_end" &&
    typeof event.toolCallId === "string" &&
    typeof event.toolName === "string"
  ) {
    const call = { toolCallId: event.toolCallId, toolName: event.toolName };
    yield event.isError === true
      ? { type: "tool-error", ...call, error: JSON.stringify(event.result) }
      : { type: "tool-result", ...call, output: event.result };
  }
}
