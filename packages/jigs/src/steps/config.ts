// Harness descriptors are tagged plain data (ADR 0008): nothing live crosses
// the workflow/step boundary, so a factory call returns options + a kind tag
// and the step hydrates the real provider from it.

// A real tool call is the only honest availability evidence (ADR 0011 —
// agents misreport their own server list), and no tool is universally
// side-effect-free, so the step declares which one the JIT check may call.
// Required: TypeScript is the enforcement, not plan-time validation code.
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

// Both v0 harnesses honor a JSON schema natively; the table exists so a
// future capability-less harness fails loudly at build time, never by
// silently coercing prose (ADR 0003).
export const STRUCTURED_OUTPUT_SUPPORT: Record<HarnessConfig["kind"], boolean> =
  {
    claude: true,
    codex: true,
  };

export class StructuredOutputUnsupportedError extends Error {
  constructor(kind: string) {
    super(
      `harness '${kind}' cannot honor a structured output schema — remove \`output\` or use a harness with native structured output`,
    );
    this.name = "StructuredOutputUnsupportedError";
  }
}
