import type { LanguageModelUsage } from "ai";
import type { Harness } from "./harness-config.ts";

// Type aliases, not interfaces: aliases carry an implicit index signature,
// which keeps step returns assignable to the SDK's Serializable types.

/** Token usage reported by the underlying model provider. */
export type ModelUsage = LanguageModelUsage & {
  /** The driver's own estimate, not a bill. */
  costUsd?: number;
};

/** A provider session pointer that can resume the same harness. */
export type AgentSession = {
  harness: Harness["kind"];
  id: string;
};

/** Text, structured output and usage returned by a model call. */
export type ModelResult<T = unknown> = {
  text: string;
  output: T;
  usage?: ModelUsage;
};

/** A model result with the optional session pointer from an agent harness. */
export type AgentResult<T = unknown> = ModelResult<T> & {
  session?: AgentSession;
};

type ProviderMetadataLike = Record<string, Record<string, unknown>> | null;

// The structural slice of an AI SDK GenerateTextResult the normalizer needs —
// what the executor deps seam fakes in tests.
export type ModelGeneration = {
  text: string;
  usage: ModelUsage;
  costUsd?: number;
  providerMetadata?: ProviderMetadataLike;
};

export function toModelResult(generation: ModelGeneration, output: unknown): ModelResult<unknown> {
  return {
    text: generation.text,
    output,
    usage:
      generation.costUsd === undefined
        ? generation.usage
        : { ...generation.usage, costUsd: generation.costUsd },
  };
}

// Best-effort: session pointers are capturable only at step time, but a
// missing one must never fail the step the agent just finished.
export function extractAgentSession(
  harness: AgentSession["harness"],
  providerMetadata: ProviderMetadataLike | undefined,
  pointer: { providerKey: string; field: string } | undefined,
): AgentSession | undefined {
  if (pointer === undefined) return undefined;
  const id = providerMetadata?.[pointer.providerKey]?.[pointer.field];
  if (typeof id !== "string" || id === "") return undefined;
  return { harness, id };
}
