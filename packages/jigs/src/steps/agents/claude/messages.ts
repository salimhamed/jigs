import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSourcePart } from "../shared/step-stream.ts";
import type { ExecutorGeneration } from "../shared/types.ts";

type Block = Record<string, unknown>;

function blocks(content: unknown): Block[] {
  return Array.isArray(content)
    ? content.filter((block): block is Block => typeof block === "object" && block !== null)
    : [];
}

// A tool result's content is a string or content blocks; blocks other than text, such as an
// image, show as their type.
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return blocks(content)
    .map((block) =>
      block.type === "text" && typeof block.text === "string" ? block.text : `[${block.type}]`,
    )
    .join("\n");
}

/** Map Claude Code's messages to step-stream parts, naming each tool result after its call. */
export function claudeStreamParts(): (message: SDKMessage) => Generator<AgentSourcePart> {
  const toolNames = new Map<string, string>();
  // Each text block is whole, and the step stream joins adjacent text, so blocks
  // in a row need their own separator.
  let afterText = false;
  return function* (message) {
    if (message.type === "assistant") {
      for (const block of blocks(message.message.content)) {
        const isText = block.type === "text" && typeof block.text === "string";
        if (isText) {
          yield { type: "text-delta", text: `${afterText ? "\n\n" : ""}${block.text}` };
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
        afterText = isText;
      }
    }
    if (message.type === "user") {
      for (const block of blocks(message.message.content)) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        afterText = false;
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
  const output = result.structured_output;
  if (output === undefined) {
    throw new Error("Claude Code returned no structured output for the requested schema");
  }
  return { text: JSON.stringify(output), output, providerMetadata };
}
