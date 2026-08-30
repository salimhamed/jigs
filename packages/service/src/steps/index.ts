// The three step builders (ADR 0003) on the Workflow SDK (ADR 0008): plain
// workflow-side functions that plan a fully-serializable wire, hand it to the
// step function the factory injects, and zod-parse the recorded raw output
// back into the typed StepResult. Memoization is the SDK's positional replay —
// no author-supplied keys anywhere.
//
// Nothing in this package carries a "use step" directive. The wrappers live in
// the factory repo, so the ids the SDK derives are factory-local paths and no
// @jigs/service version is baked into a memoization key. This module is the
// workflow side of that split; ./run is the step side.

import {
  type AgentStepConfig,
  type AgentStepResult,
  type AgentWire,
  type AskStepConfig,
  type AskWire,
  buildAgentWire,
  buildAskWire,
  type StepResult,
} from "jigs/steps";
import type { z } from "zod";

// Thrown workflow-side, never inside the step: a step's rejection is rebuilt
// from its message alone, so a JIT failure crosses the boundary as a returned
// value and becomes an error here, where `instanceof` still means something.
export class JitCheckError extends Error {
  constructor(failures: string) {
    super(failures);
    this.name = "JitCheckError";
  }
}

// Same shape, same reason: a stale session pointer crosses the boundary as a
// returned marker so the SDK does not retry it, and becomes an error here.
export class ResumeFailedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ResumeFailedError";
  }
}

/** The factory's `"use step"` wrapper around `runAgent` from ./run. */
export type RunAgentStep = (
  wire: AgentWire,
) => Promise<
  AgentStepResult | { jitFailure: string } | { resumeFailed: string }
>;

/** The factory's `"use step"` wrapper around `runAsk` from ./run. */
export type RunAskStep = (wire: AskWire) => Promise<StepResult>;

/** {@link agent} with its step wrapper already bound — what a jig is handed. */
export type AgentFn = <T = undefined>(
  config: AgentStepConfig<T>,
) => Promise<AgentStepResult<T>>;

/** {@link ask} with its step wrapper already bound. */
export type AskFn = <T = undefined>(
  config: AskStepConfig<T>,
) => Promise<StepResult<T>>;

// The executor asks the harness for schema-conformant output; the real
// validation is this workflow-side zod parse of the recorded raw output —
// deterministic on replay, and where the result gets its `T`.
export function parseOutput<T>(
  schema: z.ZodType<T> | undefined,
  raw: unknown,
): T {
  return schema === undefined ? (undefined as T) : schema.parse(raw);
}

// Where the step's returned markers become errors: workflow-side, so no
// retries are spent and `instanceof` still means something to the caller.
export function unwrapAgentStep(
  result: Awaited<ReturnType<RunAgentStep>>,
): AgentStepResult {
  if ("jitFailure" in result) throw new JitCheckError(result.jitFailure);
  if ("resumeFailed" in result) {
    throw new ResumeFailedError(result.resumeFailed);
  }
  return result;
}

export async function agent<T = undefined>(
  config: AgentStepConfig<T>,
  runStep: RunAgentStep,
): Promise<AgentStepResult<T>> {
  const wire = buildAgentWire(config);
  const result = unwrapAgentStep(await runStep(wire));
  return { ...result, output: parseOutput(config.output, result.output) };
}

export async function ask<T = undefined>(
  config: AskStepConfig<T>,
  runStep: RunAskStep,
): Promise<StepResult<T>> {
  const wire = buildAskWire(config);
  const result = await runStep(wire);
  return { ...result, output: parseOutput(config.output, result.output) };
}

/**
 * Wraps a step function's recorded return in the uniform StepResult. The
 * passed function must be a module-scope function in the factory repo
 * carrying its own `"use step"` directive: an inline closure or undirected
 * function executes unmemoized in the workflow sandbox and re-fires on every
 * replay — with no runtime error, because the workflow bundle replaces only
 * directive-bearing functions with stubs, and a stub carries no runtime marker
 * fn() could assert on. Reference-plus-serializable-args is the only honest
 * shape under the directive model.
 */
export async function fn<Args extends unknown[], R>(
  step: (...args: Args) => R | Promise<R>,
  ...args: Args
): Promise<StepResult<R>> {
  const output = await step(...args);
  return { text: "", output, files: [], usage: undefined };
}
