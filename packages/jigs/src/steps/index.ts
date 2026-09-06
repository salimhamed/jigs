// The workflow-side step surface: the harness configs a pipeline declares, the
// wire those configs plan into, and the builders (ADR 0003) that hand a wire
// to the step function the factory injects and zod-parse what comes back.
// Memoization is the SDK's positional replay — no author-supplied keys.
//
// Nothing reachable from here carries a "use step" directive or a node
// builtin: the wrappers live in the factory repo, so the ids the SDK derives
// are factory-local paths and no version of this package is a memoization key.
// ./run is the step side and is deliberately not re-exported.
export {
  type AgentFn,
  agent,
  ask,
  JitCheckError,
  parseOutput,
  type ResumeOrRebuildOptions,
  type ResumeOrRebuildResult,
  type RunAgentStep,
  type RunAskStep,
  resumeOrRebuild,
  unwrapAgentStep,
} from "./builders.ts";
export {
  type ClaudeHarnessConfig,
  type CodexHarnessConfig,
  claude,
  codex,
  type HarnessConfig,
  type HarnessOptions,
  type McpHttpServer,
  type McpProbe,
  type McpServerConfig,
  type McpStdioServer,
} from "./config.ts";
export {
  type AgentStepConfig,
  type AgentWire,
  type AskStepConfig,
  type AskWire,
  buildAgentWire,
  buildAskWire,
  type WireJsonSchema,
} from "./plan.ts";
export type {
  AgentSession,
  AgentStepResult,
  StepResult,
  StepUsage,
} from "./result.ts";
