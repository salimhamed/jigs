// Harness descriptors are tagged plain data: nothing live crosses the
// workflow/step boundary, so a factory call returns options + a kind tag and
// the step hydrates the real provider from it.

import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import type { CodexAppServerSettings } from "ai-sdk-provider-codex-cli";

// A real tool call is the only honest availability evidence — agents misreport
// their own server list — and no tool is universally side-effect-free, so the
// step declares which one the JIT check may call. Required: TypeScript is the
// enforcement, not plan-time validation code.
/** A harmless MCP tool call used to prove that a configured server is available. */
export type McpToolProbe = {
  tool: string;
  arguments?: Record<string, unknown>;
};

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

type SharedHarnessOptions = {
  model: string;
  mcpServers?: Record<string, McpServerConfig>;
};

/** Serializable options for the Claude Code harness. */
export type ClaudeHarnessOptions = SharedHarnessOptions & {
  kind: "claude";
  effort?: NonNullable<ClaudeCodeSettings["effort"]>;
};

/** Serializable options for the Codex harness. */
export type CodexHarnessOptions = SharedHarnessOptions & {
  kind: "codex";
  effort?: Extract<
    NonNullable<CodexAppServerSettings["effort"]>,
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  >;
};

/** Options accepted by either supported agent harness. */
export type HarnessOptions = ClaudeHarnessOptions | CodexHarnessOptions;

/** A complete Claude Code harness descriptor. */
export type ClaudeHarnessConfig = ClaudeHarnessOptions;
/** A complete Codex harness descriptor. */
export type CodexHarnessConfig = CodexHarnessOptions;

/** A complete descriptor for a supported agent harness. */
export type HarnessConfig = ClaudeHarnessConfig | CodexHarnessConfig;

/** Build a Claude Code harness descriptor. */
export function claude(options: Omit<ClaudeHarnessOptions, "kind">): ClaudeHarnessConfig {
  return { kind: "claude", ...options };
}

/** Build a Codex harness descriptor. */
export function codex(options: Omit<CodexHarnessOptions, "kind">): CodexHarnessConfig {
  return { kind: "codex", ...options };
}

/** The stable name of a supported agent harness. */
export type HarnessKind = HarnessConfig["kind"];

const harnesses = { claude, codex } as const;

/**
 * Build a harness from the name a caller chose, falling back to that harness's
 * own default model. The map is the factory's: jigs knows no model names.
 */
export function selectHarness(
  harness: HarnessKind,
  defaultModels: Record<HarnessKind, string>,
  model?: string,
): HarnessConfig {
  return harnesses[harness]({ model: model ?? defaultModels[harness] });
}
