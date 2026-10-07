import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSourcePart } from "../shared/step-stream.ts";
import type { ExecutorGeneration } from "../shared/types.ts";

type Block = Record<string, unknown>;

function blocks(content: unknown): Block[] {
  return Array.isArray(content)
    ? content.filter((block): block is Block => typeof block === "object" && block !== null)
    : [];
}

function resultText(content: unknown): unknown {
  const parts = blocks(content);
  if (parts.length === 0 || parts.some((part) => part.type !== "text")) return content;
  return parts.map((part) => part.text).join("\n");
}

/** Map Claude Code's messages to step-stream parts, naming each tool result after its call. */
export function claudeStreamParts(): (message: SDKMessage) => Generator<AgentSourcePart> {
  const toolNames = new Map<string, string>();
  return function* (message) {
    if (message.type === "assistant") {
      for (const block of blocks(message.message.content)) {
        if (block.type === "text" && typeof block.text === "string") {
          yield { type: "text-delta", text: block.text };
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          yield { type: "reasoning-delta", text: block.thinking };
        } else if (typeof block.id === "string" && typeof block.name === "string") {
          toolNames.set(block.id, block.name);
          yield {
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
          };
        }
      }
    }
    if (message.type === "user") {
      for (const block of blocks(message.message.content)) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const call = {
          toolCallId: block.tool_use_id,
          toolName: toolNames.get(block.tool_use_id) ?? "unknown",
        };
        const output = resultText(block.content);
        yield block.is_error === true
          ? { type: "tool-error", ...call, error: output }
          : { type: "tool-result", ...call, output };
      }
    }
  };
}

// The text itself, or the last fenced block in it, when it parses as a JSON object.
function jsonObjectIn(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)].map((match) => match[1]);
  for (const candidate of [text, ...fenced.reverse()]) {
    try {
      const parsed: unknown = JSON.parse(candidate?.trim() ?? "");
      if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch {}
  }
  return undefined;
}

/**
 * The generation a result message answers, or the error it reports. `errorKind` is the error the
 * last assistant message carried, such as `authentication_failed`.
 */
export function claudeGeneration(
  result: SDKResultMessage,
  structured: boolean,
  errorKind?: string,
): ExecutorGeneration {
  if (result.subtype === "error_max_structured_output_retries") {
    throw new Error(
      "Claude Code could not produce output matching the schema after its maximum retries",
    );
  }
  if (result.subtype !== "success" || result.is_error) {
    const detail =
      result.subtype === "success" ? result.result : result.errors.filter(Boolean).join("; ");
    const kind = errorKind === undefined ? "" : ` (${errorKind})`;
    throw new Error(`Claude Code failed${kind}: ${detail || result.subtype}`);
  }
  const providerMetadata = { claude: { sessionId: result.session_id } };
  if (!structured) return { text: result.result, providerMetadata };
  // Claude Code can fall back to prose for a schema it cannot enforce.
  const output = result.structured_output ?? jsonObjectIn(result.result);
  if (output === undefined) {
    throw new Error(
      "Claude Code returned no structured output, and its reply holds no JSON object",
    );
  }
  return { text: JSON.stringify(output), output, providerMetadata };
}
