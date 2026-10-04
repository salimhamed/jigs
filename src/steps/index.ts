/**
 * APIs for implementing a factory-owned custom agent step. Most workflows use
 * `runAgent` and other generated routines instead.
 *
 * Call these inside `"use step"` code. `createAgentRunner` provides a live provider
 * model with jigs policy applied. Driver interfaces are advanced extension contracts.
 * See [Custom agent steps](https://salimhamed.github.io/jigs/guide/custom-agent-step).
 *
 * @module steps
 * @packageDocumentation
 */

export type { Check, CheckResult } from "../checks/check.ts";
export { ProviderApiError } from "../providers/http.ts";
export {
  type AgentRunner,
  type AgentRunnerOptions,
  createAgentRunner,
} from "./agents/shared/runner.ts";
export { AgentSessionError } from "./agents/shared/session-error.ts";
export type {
  DecisionGeneration,
  Driver,
  DriverContext,
  DriverDependencies,
  DriverDescriptor,
  DriverRequest,
  EvaluationGeneration,
  ExecutorGeneration,
  HarnessTarget,
  OpenContext,
  OpenedModel,
  RunRequest,
} from "./agents/shared/types.ts";
export type { RunMetadata } from "./runtime/run-context.ts";
