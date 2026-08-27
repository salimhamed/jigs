// Harness descriptors are tagged plain data (ADR 0008): nothing live crosses
// the workflow/step boundary, so a factory call returns options + a kind tag
// and the step hydrates the real provider from it.

export type McpStdioServer = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpHttpServer = {
  url: string;
  headers?: Record<string, string>;
};

export type McpServerConfig = McpStdioServer | McpHttpServer;

export type ClaudeHarnessOptions = {
  model: string;
  mcpServers?: Record<string, McpServerConfig>;
};

export type CodexHarnessOptions = {
  model: string;
  mcpServers?: Record<string, McpServerConfig>;
};

export type ClaudeHarnessConfig = ClaudeHarnessOptions & { kind: "claude" };
export type CodexHarnessConfig = CodexHarnessOptions & { kind: "codex" };

export type HarnessConfig = ClaudeHarnessConfig | CodexHarnessConfig;

export function claude(options: ClaudeHarnessOptions): ClaudeHarnessConfig {
  return { kind: "claude", ...options };
}

export function codex(options: CodexHarnessOptions): CodexHarnessConfig {
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
