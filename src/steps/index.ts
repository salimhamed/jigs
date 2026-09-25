/**
 * Build a factory's own agent step. `createAgentRunner` opens a harness the way the built-in
 * agent step does and hands back the live provider model.
 *
 * Call these inside a factory-owned `"use step"` function, never from a workflow. `Driver`,
 * `DriverContext`, `AgentRunner` and the types they reach are a published contract: a change to
 * any of them is a breaking release.
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
