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
/** A Pi harness descriptor. Its driver is supplied separately. */
export type PiHarness = SharedHarness & { kind: "pi"; provider: OpenaiCodexSource };
/** A serializable agent-program descriptor. */
export type Harness = ClaudeHarness | CodexHarness | PiHarness;
/** The stable name of an agent harness. */
export type HarnessKind = Harness["kind"];

/** An OpenRouter API model source. */
export type OpenrouterSource = { kind: "openrouter"; model: string };
/** An OpenAI-compatible API model source. */
export type OpenaiCompatibleSource = { kind: "openai-compatible"; model: string; baseUrl: string };
/** The Codex subscription model source used only by the Pi harness. */
export type OpenaiCodexSource = { kind: "openai-codex"; model: string };
/** Any configured source from which a model can answer. */
export type ModelSource = OpenrouterSource | OpenaiCompatibleSource | OpenaiCodexSource;
/** A model source accepted by a direct model call. */
export type AskableModelSource = Exclude<ModelSource, OpenaiCodexSource>;
/** The stable name of a model source. */
export type ModelKind = ModelSource["kind"];

/** Constructors for model-source descriptors. */
export const models = {
  openrouter(model: string): OpenrouterSource {
    return { kind: "openrouter", model };
  },
  openaiCompatible(model: string, options: { baseUrl: string }): OpenaiCompatibleSource {
    return { kind: "openai-compatible", model, ...options };
  },
  openaiCodex(model: string): OpenaiCodexSource {
    return { kind: "openai-codex", model };
  },
} as const;

/** Constructors for agent-harness descriptors. */
export const harnesses = {
  claude(model: string, options: Omit<ClaudeHarness, "kind" | "model"> = {}): ClaudeHarness {
    return { kind: "claude", model, ...options };
  },
  codex(model: string, options: Omit<CodexHarness, "kind" | "model"> = {}): CodexHarness {
    return { kind: "codex", model, ...options };
  },
  pi(model: string, options: Omit<PiHarness, "kind" | "model">): PiHarness {
    return { kind: "pi", model, ...options };
  },
} as const;
