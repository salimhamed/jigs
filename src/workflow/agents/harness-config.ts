// Descriptors are tagged plain data: nothing live crosses the workflow/step boundary.

import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import type { CodexAppServerSettings } from "ai-sdk-provider-codex-cli";
import { JigsError } from "../errors.ts";

/**
 * A harmless MCP tool call used to prove that a configured server is available.
 *
 * @group Harnesses and models
 */
export type McpToolProbe = { tool: string; arguments?: Record<string, unknown> };
/**
 * Configuration for an MCP server launched as a child process.
 *
 * @group Harnesses and models
 */
export type McpStdioServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  probe: McpToolProbe;
};
/**
 * Configuration for an MCP server reached over HTTP.
 *
 * @group Harnesses and models
 */
export type McpHttpServerConfig = {
  url: string;
  headers?: Record<string, string>;
  probe: McpToolProbe;
};
/**
 * An MCP server an agent harness can expose to the model.
 *
 * @group Harnesses and models
 */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/**
 * A stdio MCP server Pi exposes through an explicit direct-tool allowlist.
 *
 * @group Harnesses and models
 */
export type PiMcpStdioServerConfig = Omit<McpStdioServerConfig, "env"> & {
  /** Maps child variable names to step-side source environment variable names. */
  env?: Record<string, string>;
  /** Raw MCP tool names the model may call. This must include the probe tool. */
  tools: string[];
};
/**
 * An HTTP MCP server Pi exposes through an explicit direct-tool allowlist.
 *
 * @group Harnesses and models
 */
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
/**
 * An explicitly configured MCP server accepted by the Pi harness.
 *
 * @group Harnesses and models
 */
export type PiMcpServerConfig = PiMcpStdioServerConfig | PiMcpHttpServerConfig;

// A value that can be written down: nothing callable anywhere inside it. Keys
// typed `unknown` or `any` count as data. Depth is capped so the provider's
// large settings types stay cheap to check.
type IsData<T, Depth extends unknown[] = []> = unknown extends T
  ? true
  : Depth["length"] extends 6
    ? true
    : T extends (...args: never[]) => unknown
      ? false
      : T extends readonly (infer E)[]
        ? IsData<E, [...Depth, unknown]>
        : T extends object
          ? false extends {
              [K in keyof T]-?: IsData<Exclude<T[K], undefined>, [...Depth, unknown]>;
            }[keyof T]
            ? false
            : true
          : true;

/**
 * The keys of a settings type whose values are data, so they can cross into a step.
 *
 * @group Harnesses and models
 */
export type JsonOnly<T> = {
  [K in keyof T as false extends IsData<Exclude<T[K], undefined>> ? never : K]: T[K];
};

// The drivers also strip these at run time, so a descriptor that skipped the
// constructor still cannot carry them.
export const claudePolicyKeys = [
  "cwd",
  "env",
  "pathToClaudeCodeExecutable",
  "executable",
  "executableArgs",
  "permissionMode",
  "allowDangerouslySkipPermissions",
  "strictMcpConfig",
  "mcpServers",
  "settingSources",
  "resume",
  "continue",
  "sessionId",
  "forkSession",
  "persistSession",
  "resumeSessionAt",
  "resumeDropsTurn",
  "extraArgs",
  "sdkOptions",
  "agents",
  "settings",
  "plugins",
] as const satisfies readonly (keyof ClaudeCodeSettings)[];
/**
 * A Claude Code setting a descriptor cannot name, because jigs sets it itself or holds it as
 * policy.
 *
 * @remarks
 * jigs sets the working directory, environment, executable and session for every step, and holds
 * permissions, setting sources and MCP servers as policy. `extraArgs` and `sdkOptions` would
 * rewrite any of those. `agents`, `settings` and `plugins` would bring in unprobed MCP servers,
 * environment, permissions and hooks from outside the worktree; they come from the repository's
 * project settings instead.
 *
 * @group Harnesses and models
 */
export type ClaudePolicyKey = (typeof claudePolicyKeys)[number];

export const codexPolicyKeys = [
  "cwd",
  "env",
  "codexPath",
  "approvalPolicy",
  "sandboxPolicy",
  "autoApprove",
  "threadMode",
  "resume",
  "persistExtendedHistory",
  "configOverrides",
  "mcpServers",
] as const satisfies readonly (keyof CodexAppServerSettings)[];
/**
 * A Codex setting a descriptor cannot name, because jigs sets it itself or holds it as policy.
 *
 * @remarks
 * jigs sets the working directory, environment, executable, thread and session for every step,
 * and holds the approval and sandbox policies and MCP servers. `configOverrides` would rewrite
 * the sandbox and MCP tables.
 *
 * @group Harnesses and models
 */
export type CodexPolicyKey = (typeof codexPolicyKeys)[number];

/**
 * A Claude Code harness descriptor: the provider's own settings that are data, minus each
 * {@link ClaudePolicyKey}, plus the model and jigs' MCP server shape.
 *
 * @group Harnesses and models
 */
export type ClaudeHarness = JsonOnly<Omit<ClaudeCodeSettings, ClaudePolicyKey>> & {
  kind: "claude";
  model: string;
  mcpServers?: Record<string, McpServerConfig>;
};
/**
 * A Codex harness descriptor: the provider's own settings that are data, minus each
 * {@link CodexPolicyKey}, plus the model and jigs' MCP server shape.
 *
 * @group Harnesses and models
 */
export type CodexHarness = JsonOnly<Omit<CodexAppServerSettings, CodexPolicyKey>> & {
  kind: "codex";
  model: string;
  mcpServers?: Record<string, McpServerConfig>;
};
type SharedPiHarness = {
  kind: "pi";
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  tools?: string[];
  mcpServers?: Record<string, PiMcpServerConfig>;
};

/**
 * An OpenRouter API model source.
 *
 * @group Harnesses and models
 */
export type OpenrouterSource = { kind: "openrouter"; model: string; apiKeyEnv: string };
/**
 * Pi-specific compatibility hints for an OpenAI-compatible model.
 *
 * @group Harnesses and models
 */
export type PiOpenaiCompatibleOptions = {
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
};
/**
 * An OpenAI-compatible API model source.
 *
 * @group Harnesses and models
 */
export type OpenaiCompatibleSource = {
  kind: "openai-compatible";
  name: string;
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
};
/**
 * The Codex subscription model source used only by the Pi harness.
 *
 * @group Harnesses and models
 */
export type OpenaiCodexSource = { kind: "openai-codex"; model: string };
/**
 * Any configured source from which a model can answer.
 *
 * @group Harnesses and models
 */
export type ModelSource = OpenrouterSource | OpenaiCompatibleSource | OpenaiCodexSource;
/**
 * A model source accepted by a direct model call.
 *
 * @group Harnesses and models
 */
export type AskableModelSource = Exclude<ModelSource, OpenaiCodexSource>;
/**
 * The stable name of a model source.
 *
 * @group Harnesses and models
 */
export type ModelKind = ModelSource["kind"];

/**
 * A Pi harness descriptor backed by an OpenAI-compatible source, with its compatibility hints.
 *
 * @group Harnesses and models
 */
export type PiOpenaiCompatibleHarness = SharedPiHarness & {
  model: OpenaiCompatibleSource;
  compat: PiOpenaiCompatibleOptions;
};
/**
 * A Pi harness descriptor backed by any source other than an OpenAI-compatible one.
 *
 * @group Harnesses and models
 */
export type PiOtherHarness = SharedPiHarness & {
  model: Exclude<ModelSource, OpenaiCompatibleSource>;
  compat?: never;
};
/**
 * A Pi harness descriptor backed by a nested model source.
 *
 * @group Harnesses and models
 */
export type PiHarness = PiOpenaiCompatibleHarness | PiOtherHarness;
/**
 * A serializable agent-program descriptor.
 *
 * @group Harnesses and models
 */
export type Harness = ClaudeHarness | CodexHarness | PiHarness;
/**
 * Marks a descriptor that names no tools or MCP servers.
 *
 * @group Harnesses and models
 */
export type ToolFree = { tools?: never; mcpServers?: never };
/**
 * A harness `askAgent` can run with no tools: Claude Code or Pi, without MCP
 * servers or a Pi tool allowlist. Codex has no mode without tools.
 *
 * @group Harnesses and models
 */
export type AskableHarness = (ClaudeHarness & ToolFree) | (PiHarness & ToolFree);
/**
 * The stable name of an agent harness.
 *
 * @group Harnesses and models
 */
export type HarnessKind = Harness["kind"];

/**
 * Constructors for model-source descriptors.
 *
 * @group Harnesses and models
 */
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
 *
 * @group Harnesses and models
 */
export type PiHarnessOptions = Pick<PiHarness, "thinking" | "tools" | "mcpServers"> & {
  compat?: Partial<PiOpenaiCompatibleOptions>;
};
/**
 * The one argument `harnesses.claude` takes: the model and any Claude Code settings.
 *
 * @group Harnesses and models
 */
export type ClaudeHarnessSettings = Omit<ClaudeHarness, "kind">;
/**
 * The one argument `harnesses.codex` takes: the model and any Codex settings.
 *
 * @group Harnesses and models
 */
export type CodexHarnessSettings = Omit<CodexHarness, "kind">;
// Rejects a key the settings type does not have, even when the argument is not a fresh literal.
type Exactly<T, O> = O & { [K in Exclude<keyof O, keyof T>]: never };
/**
 * The descriptor a harness constructor returns for its options. It is also
 * {@link ToolFree}, so `askAgent` accepts it, when the options name no tools
 * or MCP servers.
 *
 * @group Harnesses and models
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

/**
 * Build a Claude Code harness from the model and any Claude Code settings. Without `tools` or
 * `mcpServers` it also works with `askAgent`.
 *
 * @example
 * ```ts
 * harnesses.claude({ model: "opus", effort: "high", maxTurns: 40 });
 * ```
 */
function claudeHarness<O extends ClaudeHarnessSettings>(
  settings: Exactly<ClaudeHarnessSettings, O>,
): HarnessForOptions<ClaudeHarness, O>;
function claudeHarness(settings: ClaudeHarnessSettings): ClaudeHarness {
  return { kind: "claude", ...settings };
}

/**
 * Build a Codex harness from the model and any Codex settings. Only `runAgent` accepts it: Codex
 * has no mode without tools.
 *
 * @example
 * ```ts
 * harnesses.codex({ model: "gpt-5.6-sol", personality: "pragmatic" });
 * ```
 */
function codexHarness<O extends CodexHarnessSettings>(
  settings: Exactly<CodexHarnessSettings, O>,
): CodexHarness;
function codexHarness(settings: CodexHarnessSettings): CodexHarness {
  return { kind: "codex", ...settings };
}

/**
 * Constructors for agent-harness descriptors.
 *
 * @group Harnesses and models
 */
export const harnesses = {
  claude: claudeHarness,
  codex: codexHarness,
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
 *
 * @group Harnesses and models
 */
export const harnessKinds = Object.keys(harnesses) as [HarnessKind, ...HarnessKind[]];
