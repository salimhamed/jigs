import type { ExecutorGeneration } from "../drivers/types.ts";
import { SUBMIT_RESULT_TOOL } from "./pi-extension.ts";

export type PiDelta = { type: string; [key: string]: unknown };

type AssistantOutcome = {
  stopReason: unknown;
  errorMessage: unknown;
  text: string;
};

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

export type PiReduceOptions = {
  /** The turn must include an accepted `submit_result` call; the first one accepted is the result. */
  requireResult?: boolean;
  onDelta?: (delta: PiDelta) => void;
};

/** Reduce Pi's JSONL event stream into the common executor result. */
export function reducePiJsonl(jsonl: string, options: PiReduceOptions = {}): ExecutorGeneration {
  const { requireResult = false, onDelta } = options;
  let sessionId: string | undefined;
  let finalAssistant: AssistantOutcome | undefined;
  let output: unknown;
  let hasOutput = false;
  let rejection: string | undefined;
  let started = false;
  let settled = false;

  for (const [index, line] of jsonl.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try {
      const parsed = record(JSON.parse(line) as unknown);
      if (parsed === undefined || typeof parsed.type !== "string") throw new Error();
      event = parsed;
    } catch {
      throw new Error(`pi emitted invalid JSON event on line ${index + 1}`);
    }

    if (event.type === "session" && sessionId === undefined && typeof event.id === "string") {
      sessionId = event.id;
    } else if (event.type === "agent_start") {
      // A trusted extension can start another run after settlement. Anything
      // collected for the older operation is then stale. Pi's own retry also
      // emits agent_start, but it remains part of the same operation and must
      // retain a submit_result already produced by that run.
      const beginsNewOperation = settled;
      started = true;
      settled = false;
      finalAssistant = undefined;
      if (beginsNewOperation) {
        output = undefined;
        hasOutput = false;
        rejection = undefined;
      }
    } else if (event.type === "message_update") {
      const delta = record(event.assistantMessageEvent);
      if (delta !== undefined) onDelta?.(delta as PiDelta);
    } else if (event.type === "message_end") {
      const message = record(event.message);
      if (message?.role !== "assistant") continue;
      finalAssistant = {
        stopReason: message.stopReason,
        errorMessage: message.errorMessage,
        text: textContent(message.content),
      };
    } else if (
      requireResult &&
      event.type === "tool_execution_end" &&
      event.toolName === SUBMIT_RESULT_TOOL &&
      !hasOutput
    ) {
      const result = record(event.result);
      if (event.isError !== true && result !== undefined && "details" in result) {
        output = result.details;
        hasOutput = true;
      } else {
        rejection = textContent(result?.content) || `${SUBMIT_RESULT_TOOL} failed`;
      }
    } else if (event.type === "agent_settled") {
      settled = true;
    }
  }

  if (!started) throw new Error("pi ended without an agent_start");
  if (!settled) throw new Error("pi ended before the agent settled");
  if (finalAssistant === undefined) {
    throw new Error("pi settled without a final assistant message");
  }

  switch (finalAssistant.stopReason) {
    case "stop":
      break;
    case "toolUse":
      if (!hasOutput) throw new Error("pi settled with an unresolved tool-only response");
      break;
    case "error":
      throw new Error(
        typeof finalAssistant.errorMessage === "string"
          ? finalAssistant.errorMessage
          : "pi model turn failed",
      );
    case "aborted":
      throw new Error(
        typeof finalAssistant.errorMessage === "string"
          ? finalAssistant.errorMessage
          : "pi model turn was aborted",
      );
    case "length":
      throw new Error("pi final response was truncated");
    default:
      throw new Error(
        `pi settled with invalid assistant stop reason ${JSON.stringify(finalAssistant.stopReason)}`,
      );
  }

  if (requireResult && !hasOutput)
    throw new Error(
      rejection === undefined
        ? `pi finished without calling ${SUBMIT_RESULT_TOOL}`
        : `pi finished without an accepted ${SUBMIT_RESULT_TOOL} call: ${rejection}`,
    );

  return {
    text: finalAssistant.text,
    ...(hasOutput ? { output } : {}),
    providerMetadata: {
      pi: {
        ...(sessionId === undefined ? {} : { sessionId }),
      },
    },
  };
}
