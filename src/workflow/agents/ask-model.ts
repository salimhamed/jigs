import { type AskModelOptions, buildModelRequest, type ModelRequest, parseOutput } from "./plan.ts";
import type { ModelResult } from "./result.ts";

/**
 * The factory's `"use step"` wrapper around `executeModel`.
 *
 * @group Factory plumbing
 */
export type ExecuteModelStep = (wire: ModelRequest) => Promise<ModelResult>;

/** Make one API model call and parse its optional structured output. */
export async function askModel<T = undefined>(
  config: AskModelOptions<T>,
  executeModel: ExecuteModelStep,
): Promise<ModelResult<T>> {
  const wire = buildModelRequest(config);
  const result = await executeModel(wire);
  return { ...result, output: parseOutput(config.output, result.output) };
}
