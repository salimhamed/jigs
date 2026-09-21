import type { ExecutorGeneration } from "../drivers/types.ts";

export type PiDelta = { type: string; [key: string]: unknown };

type PiUsage = {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  reasoning?: unknown;
  totalTokens?: unknown;
  cost?: { total?: unknown };
};

function number(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function usage(value: PiUsage | undefined): ExecutorGeneration["usage"] {
  const input = number(value?.input);
  const output = number(value?.output);
  const reasoning = number(value?.reasoning);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: number(value?.totalTokens),
    inputTokenDetails: {
      noCacheTokens: input,
      cacheReadTokens: number(value?.cacheRead),
      cacheWriteTokens: number(value?.cacheWrite),
    },
    outputTokenDetails: {
      textTokens: Math.max(0, output - reasoning),
      reasoningTokens: reasoning,
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const item = record(part);
      return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("");
}

/** Reduce Pi's JSONL event stream into the common executor result. */
export function reducePiJsonl(
  jsonl: string,
  onDelta?: (delta: PiDelta) => void,
): ExecutorGeneration {
  let sessionId: string | undefined;
  let finalText = "";
  let finalUsage: PiUsage | undefined;
  let output: unknown;
  let completed = false;

  for (const [index, line] of jsonl.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`pi emitted invalid JSON on line ${index + 1}`);
    }

    if (event.type === "session" && sessionId === undefined && typeof event.id === "string") {
      sessionId = event.id;
    } else if (event.type === "message_update") {
      const delta = record(event.assistantMessageEvent);
      if (delta !== undefined) onDelta?.(delta as PiDelta);
    } else if (event.type === "message_end") {
      const message = record(event.message);
      if (message?.role !== "assistant") continue;
      if (message.stopReason === "error") {
        throw new Error(
          typeof message.errorMessage === "string" ? message.errorMessage : "pi model turn failed",
        );
      }
      completed = true;
      finalText = textContent(message.content);
      finalUsage = record(message.usage) as PiUsage | undefined;
    } else if (event.type === "tool_execution_end" && event.toolName === "submit_result") {
      const result = record(event.result);
      output = result?.details;
    }
  }

  if (!completed) throw new Error("pi ended without an assistant message_end");

  const cost = finalUsage?.cost?.total;
  return {
    text: finalText,
    usage: usage(finalUsage),
    ...(output === undefined ? {} : { output }),
    providerMetadata: {
      pi: {
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(typeof cost === "number" ? { costUsd: cost } : {}),
      },
    },
  };
}
