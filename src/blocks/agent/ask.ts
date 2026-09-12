// The workflow side of a plain model request: one model call with no worktree
// and no MCP universe. ../../steps/agent/run-ask.ts is the step side.

import { type AskStepConfig, type AskWire, buildAskWire, parseOutput } from "./plan.ts";
import type { StepResult } from "./result.ts";

/** The factory's `"use step"` wrapper around `executeModelRequest`. */
export type ExecuteModelRequestStep = (wire: AskWire) => Promise<StepResult>;

export async function askModel<T = undefined>(
  config: AskStepConfig<T>,
  executeModelRequest: ExecuteModelRequestStep,
): Promise<StepResult<T>> {
  const wire = buildAskWire(config);
  const result = await executeModelRequest(wire);
  return { ...result, output: parseOutput(config.output, result.output) };
}
