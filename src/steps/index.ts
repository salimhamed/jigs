/**
 * Build a factory's own agent step. `createAgentRunner` opens a harness the way the built-in
 * agent step does and hands back the live provider model.
 *
 * Call these inside a factory-owned `"use step"` function, never from a workflow.
 *
 * @module steps
 * @packageDocumentation
 */

export { type AgentRunner, type AgentRunnerOptions, createAgentRunner } from "./agents/runner.ts";
export { AgentSessionError } from "./agents/session-error.ts";
