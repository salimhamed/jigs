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

export type { Check, CheckResult } from "../checks/catalog.ts";
export type {
  DecisionGeneration,
  Driver,
  DriverContext,
  DriverDependencies,
  DriverRequest,
  EvaluationGeneration,
  ExecutorGeneration,
  HarnessTarget,
  OpenContext,
  OpenedModel,
  RunRequest,
} from "./agents/drivers/types.ts";
export { type AgentRunner, type AgentRunnerOptions, createAgentRunner } from "./agents/runner.ts";
export { AgentSessionError } from "./agents/session-error.ts";
export type { RunMetadata } from "./runtime/run-context.ts";
