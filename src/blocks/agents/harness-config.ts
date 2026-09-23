// Descriptors are tagged plain data: nothing live crosses the workflow/step boundary.

import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import type { CodexAppServerSettings } from "ai-sdk-provider-codex-cli";
import { JigsError } from "../errors.ts";

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

/** A stdio MCP server Pi exposes through an explicit direct-tool allowlist. */
export type PiMcpStdioServerConfig = Omit<McpStdioServerConfig, "env"> & {
  /** Maps child variable names to step-side source environment variable names. */
  env?: Record<string, string>;
  /** Raw MCP tool names the model may call. This must include the probe tool. */
  tools: string[];
};
/** An HTTP MCP server Pi exposes through an explicit direct-tool allowlist. */
export type PiMcpHttpServerConfig = Omit<McpHttpServerConfig, "headers"> & {
  /** Maps HTTP header names to step-side source environment variable names. */
  headers?: Record<string, string>;
  /** Raw MCP tool names the model may call. This must include the probe tool. */
  tools: string[];
} & (
    | {
        /** Use OAuth credentials already held by the adapter's secure store. */
        auth: "oauth";
        bearerTokenEnv?: never;
      }
    | {
        /** Disable OAuth auto-detection for this server. */
        auth?: false;
        bearerTokenEnv?: never;
      }
    | {
        auth?: never;
        /** Name of the step-side environment variable containing a bearer token. */
        bearerTokenEnv: string;
      }
  );
/** An explicitly configured MCP server accepted by the Pi harness. */
export type PiMcpServerConfig = PiMcpStdioServerConfig | PiMcpHttpServerConfig;

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
  mcpServers?: Record<string, PiMcpServerConfig>;
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

/** A Pi harness descriptor backed by an OpenAI-compatible source, with its compatibility hints. */
export type PiOpenaiCompatibleHarness = SharedPiHarness & {
  model: OpenaiCompatibleSource;
  compat: PiOpenaiCompatibleOptions;
};
/** A Pi harness descriptor backed by any source other than an OpenAI-compatible one. */
export type PiOtherHarness = SharedPiHarness & {
  model: Exclude<ModelSource, OpenaiCompatibleSource>;
  compat?: never;
};
/** A Pi harness descriptor backed by a nested model source. */
export type PiHarness = PiOpenaiCompatibleHarness | PiOtherHarness;
/** A serializable agent-program descriptor. */
export type Harness = ClaudeHarness | CodexHarness | PiHarness;
/** Marks a descriptor that names no tools or MCP servers. */
export type ToolFree = { tools?: never; mcpServers?: never };
/**
 * A harness `askAgent` can run with no tools: Claude Code or Pi, without MCP
 * servers or a Pi tool allowlist. Codex has no mode without tools.
 */
export type AskableHarness = (ClaudeHarness & ToolFree) | (PiHarness & ToolFree);
/** The stable name of an agent harness. */
export type HarnessKind = Harness["kind"];

/** Constructors for model-source descriptors. */
export const models = {
  /**
   * Build an OpenRouter source. Its key is read from `OPENROUTER_API_KEY`
   * unless `apiKeyEnv` names another variable.
   */
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
  /**
   * Build a source that runs through the Codex subscription Pi is logged in
   * to. Only `harnesses.pi` accepts it.
   */
  openaiCodex(model: string): OpenaiCodexSource {
    return { kind: "openai-codex", model };
  },
} as const;

/**
 * Options for `harnesses.pi`. `compat` applies only to an OpenAI-compatible
 * model source.
 */
export type PiHarnessOptions = Pick<PiHarness, "thinking" | "tools" | "mcpServers"> & {
  compat?: Partial<PiOpenaiCompatibleOptions>;
};
/** Options for `harnesses.claude`. */
export type ClaudeHarnessOptions = Omit<ClaudeHarness, "kind" | "model">;
/**
 * The descriptor a harness constructor returns for its options. It is also
 * {@link ToolFree}, so `askAgent` accepts it, when the options name no tools
 * or MCP servers.
 */
export type HarnessForOptions<H, O> = [Extract<keyof O, keyof ToolFree>] extends [never]
  ? H & ToolFree
  : H;

/**
 * Build a Pi harness around a model source. `compat` applies only to an
 * OpenAI-compatible source; each hint omitted from it defaults to `false`.
 * Without `tools` or `mcpServers` the harness also works with `askAgent`.
 */
function piHarness<O extends PiHarnessOptions = Record<never, never>>(
  model: OpenaiCompatibleSource,
  options?: O,
): HarnessForOptions<PiOpenaiCompatibleHarness, O>;
function piHarness<O extends Omit<PiHarnessOptions, "compat"> = Record<never, never>>(
  model: Exclude<ModelSource, OpenaiCompatibleSource>,
  options?: O,
): HarnessForOptions<PiOtherHarness, O>;
// A source chosen at runtime may be OpenAI-compatible, so `compat` stays allowed and is checked on call.
function piHarness<
  M extends ModelSource,
  O extends Omit<PiHarnessOptions, "compat"> & {
    compat?: OpenaiCompatibleSource extends M ? Partial<PiOpenaiCompatibleOptions> : never;
  } = Record<never, never>,
>(model: M, options?: O): HarnessForOptions<PiHarness, O>;
function piHarness(model: ModelSource, options: PiHarnessOptions = {}): PiHarness {
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
    throw new JigsError("Pi compatibility hints apply only to OpenAI-compatible model sources");
  return { kind: "pi", model, ...harnessOptions };
}

/** Build a Claude Code harness. Without `mcpServers` it also works with `askAgent`. */
function claudeHarness<O extends ClaudeHarnessOptions = Record<never, never>>(
  model: string,
  options?: O,
): HarnessForOptions<ClaudeHarness, O>;
function claudeHarness(model: string, options: ClaudeHarnessOptions = {}): ClaudeHarness {
  return { kind: "claude", model, ...options };
}

/** Constructors for agent-harness descriptors. */
export const harnesses = {
  claude: claudeHarness,
  /** Build a Codex harness. Only `runAgent` accepts it: Codex has no mode without tools. */
  codex(model: string, options: Omit<CodexHarness, "kind" | "model"> = {}): CodexHarness {
    return { kind: "codex", model, ...options };
  },
  pi: piHarness,
} as const satisfies {
  [K in HarnessKind]: (...args: never[]) => Extract<Harness, { kind: K }>;
};

/**
 * Every harness kind this release of jigs can build, taken from the keys of
 * `harnesses`. Use it for a workflow input that names a harness, so a new kind
 * appears without editing the input.
 *
 * @example
 * ```ts
 * const inputs = z.object({ harness: z.enum(harnessKinds) });
 * ```
 */
export const harnessKinds = Object.keys(harnesses) as [HarnessKind, ...HarnessKind[]];
