import { type ExecuteAgentStep, runAgent as runAgentBlock } from "./agent.ts";
import { askAgent as askAgentBlock } from "./ask-agent.ts";
import { askModel as askModelBlock, type ExecuteModelStep } from "./ask-model.ts";
import type { AskAgentOptions, AskModelOptions, RunAgentOptions } from "./plan.ts";

/** The factory's reserved wrapper for the future judge/evaluate/verify verb. */
export type ExecuteJevStep = (wire: unknown) => Promise<never>;

/** The raw durable wrappers a factory supplies, one per execution role. */
export interface AgentSteps {
  executeAgent: ExecuteAgentStep;
  executeModel: ExecuteModelStep;
  executeJev: ExecuteJevStep;
}

/** Connect agent calls to durable steps without requiring a ticket integration. */
export function bindAgentSteps(steps: AgentSteps) {
  function runAgent<T = undefined>(config: RunAgentOptions<T>) {
    return runAgentBlock(config, steps.executeAgent);
  }
  function askAgent<T = undefined>(config: AskAgentOptions<T>) {
    return askAgentBlock(config, steps.executeAgent);
  }
  function askModel<T = undefined>(config: AskModelOptions<T>) {
    return askModelBlock(config, steps.executeModel);
  }
  return { runAgent, askAgent, askModel };
}
