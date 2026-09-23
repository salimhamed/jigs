/**
 * Compose agent and model calls inside a workflow, including harness selection and halts.
 *
 * @packageDocumentation
 */

export { interpolate } from "../interpolate.ts";
export {
  type ExecuteAgentStep,
  JitCheckError,
  runAgent,
  unwrapAgentStep,
} from "./agent.ts";
export { type RunAgentOrHaltDependencies, runAgentOrHalt } from "./agent-or-halt.ts";
export { askAgent } from "./ask-agent.ts";
export { askModel, type ExecuteModelStep } from "./ask-model.ts";
export { type AgentSteps, bindAgentSteps, type ExecuteJevStep } from "./bind.ts";
export {
  type AskableHarness,
  type AskableModelSource,
  type ClaudeHarness,
  type ClaudeHarnessOptions,
  type CodexHarness,
  type Harness,
  type HarnessForOptions,
  type HarnessKind,
  harnesses,
  type McpHttpServerConfig,
  type McpServerConfig,
  type McpStdioServerConfig,
  type McpToolProbe,
  type ModelKind,
  type ModelSource,
  models,
  type OpenaiCodexSource,
  type OpenaiCompatibleSource,
  type OpenrouterSource,
  type PiHarness,
  type PiHarnessOptions,
  type PiMcpHttpServerConfig,
  type PiMcpServerConfig,
  type PiMcpStdioServerConfig,
  type PiOpenaiCompatibleHarness,
  type PiOpenaiCompatibleOptions,
  type PiOtherHarness,
  type ToolFree,
} from "./harness-config.ts";
export {
  type AskJevOptions,
  askJev,
  type ChoiceQuestion,
  choice,
  type JevAnswer,
  type JevAnswers,
  type JevQuestion,
  type JevQuestions,
  type JevResult,
  type JevState,
  type ScoreQuestion,
  score,
  type YesNoQuestion,
  yesNo,
} from "./jev.ts";
export {
  type AgentRequest,
  type AskAgentOptions,
  type AskModelOptions,
  buildAgentRequest,
  buildAskAgentRequest,
  buildModelRequest,
  type ModelRequest,
  type OutputJsonSchema,
  parseOutput,
  type RunAgentOptions,
} from "./plan.ts";
export {
  type RebuildContextPrompt,
  type RebuildContextPromptInput,
  rebuildContextPrompt,
} from "./rebuild-context.prompt.ts";
export type {
  AgentResult,
  AgentSession,
  ModelResult,
} from "./result.ts";
export {
  type ResumeOrRebuildOptions,
  type ResumeOrRebuildResult,
  type RunAgentFn,
  resumeOrRebuild,
} from "./resume-or-rebuild.ts";
