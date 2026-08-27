import type { LanguageModelUsage } from "ai";
import type { HarnessConfig } from "./config.ts";

// Type aliases, not interfaces: aliases carry an implicit index signature,
// which keeps step returns assignable to the SDK's Serializable types.

export type StepUsage = LanguageModelUsage;

export type StepFile = {
  mediaType: string;
  base64: string;
};

export type AgentSession = {
  harness: HarnessConfig["kind"];
  id: string;
};

export type StepResult<T = unknown> = {
  text: string;
  output: T;
  files: StepFile[];
  usage?: StepUsage;
};

export type AgentStepResult<T = unknown> = StepResult<T> & {
  session?: AgentSession;
};

export type ProviderMetadataLike = Record<
  string,
  Record<string, unknown>
> | null;

// The structural slice of an AI SDK GenerateTextResult the normalizer needs —
// what the executor deps seam fakes in tests.
export type StepGeneration = {
  text: string;
  files: readonly { mediaType: string; base64: string }[];
  usage: StepUsage;
  providerMetadata?: ProviderMetadataLike;
};

export function toStepResult(
  generation: StepGeneration,
  output: unknown,
): StepResult<unknown> {
  return {
    text: generation.text,
    output,
    files: generation.files.map((file) => ({
      mediaType: file.mediaType,
      base64: file.base64,
    })),
    usage: generation.usage,
  };
}

const SESSION_POINTERS = {
  claude: { providerKey: "claude-code", field: "sessionId" },
  codex: { providerKey: "codex-app-server", field: "threadId" },
} as const;

// Best-effort: session pointers are capturable only at step time, but a
// missing one must never fail the step the agent just finished.
export function extractAgentSession(
  harness: AgentSession["harness"],
  providerMetadata: ProviderMetadataLike | undefined,
): AgentSession | undefined {
  const pointer = SESSION_POINTERS[harness];
  const id = providerMetadata?.[pointer.providerKey]?.[pointer.field];
  if (typeof id !== "string" || id === "") return undefined;
  return { harness, id };
}
