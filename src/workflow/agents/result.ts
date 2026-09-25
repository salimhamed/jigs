import type { Harness } from "./harness-config.ts";

// Type aliases, not interfaces: aliases carry an implicit index signature,
// which keeps step returns assignable to the SDK's Serializable types.

/**
 * A session reference: the small piece of data that lets a later `runAgent` call resume the same
 * harness session. Pass it back as `resume`.
 */
export type AgentSessionRef = {
  harness: Harness["kind"];
  id: string;
};

/** Text and structured output returned by a model call. */
export type ModelResult<T = unknown> = {
  text: string;
  output: T;
};

/** A model result with the session reference an agent harness returned, when it returned one. */
export type AgentResult<T = unknown> = ModelResult<T> & {
  session?: AgentSessionRef;
};

type ProviderMetadataLike = Record<string, Record<string, unknown>> | null;

// The structural slice of an AI SDK GenerateTextResult the normalizer needs —
// what the executor deps seam fakes in tests.
export type ModelGeneration = {
  text: string;
  providerMetadata?: ProviderMetadataLike;
};

export function toModelResult(generation: ModelGeneration, output: unknown): ModelResult<unknown> {
  return { text: generation.text, output };
}

// Best-effort: a session reference is capturable only at step time, but a
// missing one must never fail the step the agent just finished.
export function extractAgentSession(
  harness: AgentSessionRef["harness"],
  providerMetadata: ProviderMetadataLike | undefined,
  pointer: { providerKey: string; field: string } | undefined,
): AgentSessionRef | undefined {
  if (pointer === undefined) return undefined;
  const id = providerMetadata?.[pointer.providerKey]?.[pointer.field];
  if (typeof id !== "string" || id === "") return undefined;
  return { harness, id };
}
