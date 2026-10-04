import {
  type AskModelOptions,
  buildModelRequest,
  type ModelRequest,
  parseOrAskAgain,
} from "./plan.ts";
import type { ModelResult } from "./result.ts";

/**
 * The factory's `"use step"` wrapper around `executeModel`.
 *
 * @group Factory plumbing
 */
export type ExecuteModelStep = (wire: ModelRequest) => Promise<ModelResult>;

/**
 * Make an API model call and parse its optional structured output. An invalid answer is asked for
 * once more, with the reasons.
 */
export async function askModel<T = undefined>(
  config: AskModelOptions<T>,
  executeModel: ExecuteModelStep,
): Promise<ModelResult<T>> {
  const ask = (prompt: string) => executeModel(buildModelRequest({ ...config, prompt }));
  return parseOrAskAgain(config.output, await ask(config.prompt), (rejection) =>
    ask(`${config.prompt}\n\n${rejection}`),
  );
}
