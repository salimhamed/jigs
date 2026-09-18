// The workflow side of a plain model request: one model call with no worktree
// and no MCP universe. ../../steps/agents/execute-model-request.ts is the step side.

import { type AskModelOptions, buildModelRequest, type ModelRequest, parseOutput } from "./plan.ts";
import type { ModelResult } from "./result.ts";

/** The factory's `"use step"` wrapper around `executeModel`. */
export type ExecuteModelStep = (wire: ModelRequest) => Promise<ModelResult>;

export async function askModel<T = undefined>(
  config: AskModelOptions<T>,
  executeModel: ExecuteModelStep,
): Promise<ModelResult<T>> {
  const wire = buildModelRequest(config);
  const result = await executeModel(wire);
  return { ...result, output: parseOutput(config.output, result.output) };
}
