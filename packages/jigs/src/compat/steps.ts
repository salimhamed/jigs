// Temporary. This folder exists only so the folder move ships with no public
// API change: each file re-exports, by explicit name, exactly what one
// exports-map subpath exported before the move, from the blocks/ and steps/
// modules that content now lives in. Nothing inside src/ imports this folder —
// only tsdown's entry list points at it. The next PR replaces every subpath
// here with blocks/index.ts and steps/index.ts and deletes the folder whole.

export {
  agent,
  JitCheckError,
  type RunAgentStep,
  unwrapAgentStep,
} from "../blocks/agent/agent.ts";
export { ask, type RunAskStep } from "../blocks/agent/ask.ts";
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
} from "../blocks/agent/harness-config.ts";
export {
  type AgentStepConfig,
  type AgentWire,
  type AskStepConfig,
  type AskWire,
  buildAgentWire,
  buildAskWire,
  parseOutput,
  type WireJsonSchema,
} from "../blocks/agent/plan.ts";
export type {
  AgentSession,
  AgentStepResult,
  StepResult,
  StepUsage,
} from "../blocks/agent/result.ts";
export {
  type AgentFn,
  type ResumeOrRebuildOptions,
  type ResumeOrRebuildResult,
  resumeOrRebuild,
} from "../blocks/agent/resume-or-rebuild.ts";
