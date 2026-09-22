// Descriptors are tagged plain data: nothing live crosses the workflow/step boundary.

import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import type { CodexAppServerSettings } from "ai-sdk-provider-codex-cli";

/** A harmless MCP tool call used to prove that a configured server is available. */
export type McpToolProbe = { tool: string; arguments?: Record<string, unknown> };
/** Configuration for an MCP server launched as a child process. */
export type McpStdioServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  probe: McpToolProbe;
};
/** Configuration for an MCP server reached over HTTP. */
export type McpHttpServerConfig = {
  url: string;
  headers?: Record<string, string>;
  probe: McpToolProbe;
};
/** An MCP server an agent harness can expose to the model. */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

type SharedHarness = { model: string; mcpServers?: Record<string, McpServerConfig> };

/** A Claude Code harness descriptor. */
export type ClaudeHarness = SharedHarness & {
  kind: "claude";
  effort?: NonNullable<ClaudeCodeSettings["effort"]>;
};
/** A Codex harness descriptor. */
export type CodexHarness = SharedHarness & {
  kind: "codex";
  effort?: Extract<
    NonNullable<CodexAppServerSettings["effort"]>,
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  >;
};
type SharedPiHarness = {
  kind: "pi";
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  tools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
};

/** An OpenRouter API model source. */
export type OpenrouterSource = { kind: "openrouter"; model: string; apiKeyEnv: string };
/** Pi-specific compatibility hints for an OpenAI-compatible model. */
export type PiOpenaiCompatibleOptions = {
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
};
/** An OpenAI-compatible API model source. */
export type OpenaiCompatibleSource = {
  kind: "openai-compatible";
  name: string;
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
};
/** The Codex subscription model source used only by the Pi harness. */
export type OpenaiCodexSource = { kind: "openai-codex"; model: string };
/** Any configured source from which a model can answer. */
export type ModelSource = OpenrouterSource | OpenaiCompatibleSource | OpenaiCodexSource;
/** A model source accepted by a direct model call. */
export type AskableModelSource = Exclude<ModelSource, OpenaiCodexSource>;
/** The stable name of a model source. */
export type ModelKind = ModelSource["kind"];

type PiOpenaiCompatibleHarness = SharedPiHarness & {
  model: OpenaiCompatibleSource;
  compat: PiOpenaiCompatibleOptions;
};
type PiOtherHarness = SharedPiHarness & {
  model: Exclude<ModelSource, OpenaiCompatibleSource>;
  compat?: never;
};
/** A Pi harness descriptor backed by a nested model source. */
export type PiHarness = PiOpenaiCompatibleHarness | PiOtherHarness;
/** A serializable agent-program descriptor. */
export type Harness = ClaudeHarness | CodexHarness | PiHarness;
/** The stable name of an agent harness. */
export type HarnessKind = Harness["kind"];

/** Constructors for model-source descriptors. */
export const models = {
  openrouter(model: string, options: { apiKeyEnv?: string } = {}): OpenrouterSource {
    return { kind: "openrouter", model, apiKeyEnv: options.apiKeyEnv ?? "OPENROUTER_API_KEY" };
  },
  /** Build a source for an OpenAI-compatible server. */
  openaiCompatible(options: {
    name: string;
    baseUrl: string;
    model: string;
    apiKeyEnv?: string;
  }): OpenaiCompatibleSource {
    return { kind: "openai-compatible", ...options };
  },
  openaiCodex(model: string): OpenaiCodexSource {
    return { kind: "openai-codex", model };
  },
} as const;

type PiHarnessOptions = Pick<SharedPiHarness, "thinking" | "tools">;

function piHarness(
  model: OpenaiCompatibleSource,
  options?: PiHarnessOptions & { compat?: Partial<PiOpenaiCompatibleOptions> },
): PiOpenaiCompatibleHarness;
function piHarness(
  model: Exclude<ModelSource, OpenaiCompatibleSource>,
  options?: PiHarnessOptions,
): PiOtherHarness;
function piHarness(
  model: ModelSource,
  options: PiHarnessOptions & { compat?: Partial<PiOpenaiCompatibleOptions> } = {},
): PiHarness {
  const { compat, ...harnessOptions } = options;
  if (model.kind === "openai-compatible") {
    return {
      kind: "pi",
      model,
      ...harnessOptions,
      compat: {
        supportsDeveloperRole: compat?.supportsDeveloperRole ?? false,
        supportsReasoningEffort: compat?.supportsReasoningEffort ?? false,
      },
    };
  }
  if (compat !== undefined)
    throw new Error("Pi compatibility hints apply only to OpenAI-compatible model sources");
  return { kind: "pi", model, ...harnessOptions };
}

/** Constructors for agent-harness descriptors. */
export const harnesses = {
  claude(model: string, options: Omit<ClaudeHarness, "kind" | "model"> = {}): ClaudeHarness {
    return { kind: "claude", model, ...options };
  },
  codex(model: string, options: Omit<CodexHarness, "kind" | "model"> = {}): CodexHarness {
    return { kind: "codex", model, ...options };
  },
  pi: piHarness,
} as const;
