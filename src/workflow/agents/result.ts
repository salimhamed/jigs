import type { Harness } from "./harness-config.ts";

// Type aliases, not interfaces: aliases carry an implicit index signature,
// which keeps step returns assignable to the SDK's Serializable types.

/**
 * A session reference: the small piece of data that lets a later `runAgent` call resume the same
 * harness session. Pass it back as `resume`.
 *
 * @group Agent and model requests/results
 */
export type AgentSessionRef = {
  harness: Harness["kind"];
  id: string;
  /** The harness descriptor the session was recorded on, as {@link describeHarness} renders it. */
  descriptor: string;
};

/**
 * A harness descriptor as a string that ignores field order: two descriptors that list the same
 * settings in another order render the same.
 *
 * @group Agent and model requests/results
 */
export function describeHarness(harness: Harness): string {
  return JSON.stringify(harness, (_key, field: unknown) =>
    field !== null && typeof field === "object" && !Array.isArray(field)
      ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : field,
  );
}

/**
 * Text and structured output returned by a model call.
 *
 * @group Agent and model requests/results
 */
export type ModelResult<T = unknown> = {
  text: string;
  output: T;
};

/**
 * A model result with the session reference an agent harness returned, when it returned one.
 *
 * @group Agent and model requests/results
 */
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
  harness: Harness,
  providerMetadata: ProviderMetadataLike | undefined,
  ref: { providerKey: string; field: string } | undefined,
): AgentSessionRef | undefined {
  if (ref === undefined) return undefined;
  const id = providerMetadata?.[ref.providerKey]?.[ref.field];
  if (typeof id !== "string" || id === "") return undefined;
  return { harness: harness.kind, id, descriptor: describeHarness(harness) };
}
