// The workflow side of the ask step: one model call with no worktree and no
// MCP universe. ../../steps/agent/run-ask.ts is the step side.

import { type AskStepConfig, type AskWire, buildAskWire, parseOutput } from "./plan.ts";
import type { StepResult } from "./result.ts";

/** The factory's `"use step"` wrapper around `askModel`. */
export type RunAskStep = (wire: AskWire) => Promise<StepResult>;

export async function ask<T = undefined>(
  config: AskStepConfig<T>,
  runStep: RunAskStep,
): Promise<StepResult<T>> {
  const wire = buildAskWire(config);
  const result = await runStep(wire);
  return { ...result, output: parseOutput(config.output, result.output) };
}
