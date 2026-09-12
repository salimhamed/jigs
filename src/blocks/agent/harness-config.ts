// Harness descriptors are tagged plain data: nothing live crosses the
// workflow/step boundary, so a factory call returns options + a kind tag and
// the step hydrates the real provider from it.

// A real tool call is the only honest availability evidence — agents misreport
// their own server list — and no tool is universally side-effect-free, so the
// step declares which one the JIT check may call. Required: TypeScript is the
// enforcement, not plan-time validation code.
export type McpProbe = {
  tool: string;
  arguments?: Record<string, unknown>;
};

export type McpStdioServer = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  probe: McpProbe;
};

export type McpHttpServer = {
  url: string;
  headers?: Record<string, string>;
  probe: McpProbe;
};

export type McpServerConfig = McpStdioServer | McpHttpServer;

// One shared options shape until the factories actually grow different
// options; split then, not preemptively.
export type HarnessOptions = {
  model: string;
  mcpServers?: Record<string, McpServerConfig>;
};

export type ClaudeHarnessConfig = HarnessOptions & { kind: "claude" };
export type CodexHarnessConfig = HarnessOptions & { kind: "codex" };

export type HarnessConfig = ClaudeHarnessConfig | CodexHarnessConfig;

export function claude(options: HarnessOptions): ClaudeHarnessConfig {
  return { kind: "claude", ...options };
}

export function codex(options: HarnessOptions): CodexHarnessConfig {
  return { kind: "codex", ...options };
}

export type HarnessName = HarnessConfig["kind"];

const harnesses = { claude, codex } as const;

/**
 * Build a harness from the name a caller chose, falling back to that harness's
 * own default model. The map is the factory's: jigs knows no model names.
 */
export function selectHarness(
  harness: HarnessName,
  defaultModels: Record<HarnessName, string>,
  model?: string,
): HarnessConfig {
  return harnesses[harness]({ model: model ?? defaultModels[harness] });
}
