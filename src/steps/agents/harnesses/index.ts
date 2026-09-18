// jigs/harnesses — the single pin/wrap point: verbatim re-exports of the
// exact-pinned community providers, nothing else. Explicit names, not `export
// *`: the two packages export colliding helpers (tool, Logger,
// isAuthenticationError), and a future collision should break the build
// loudly. Anything not re-exported here is importable from the pinned package
// directly; if a wrapper dies, this file becomes the shim.

export {
  type ClaudeCodeModelId,
  type ClaudeCodeProvider,
  type ClaudeCodeProviderSettings,
  type ClaudeCodeSettings,
  claudeCode,
  createClaudeCode,
} from "ai-sdk-provider-claude-code";

export {
  type AppServerThreadMode,
  type CodexAppServerProvider,
  type CodexAppServerProviderOptions,
  type CodexAppServerSettings,
  type CodexExecProvider,
  type CodexExecSettings,
  type CodexModelId,
  codexAppServer,
  codexExec,
  createCodexAppServer,
  createCodexExec,
  DEFAULT_MIN_CODEX_VERSION,
} from "ai-sdk-provider-codex-cli";
