import { type ExecuteAgentStep, runAgent as runAgentBlock } from "./agent.ts";
import { askModel as askModelBlock, type ExecuteModelStep } from "./ask-model.ts";
import type { AskModelOptions, RunAgentOptions } from "./plan.ts";

/** The raw durable wrappers a factory supplies, one per execution role. */
export interface AgentSteps {
  executeAgent: ExecuteAgentStep;
  executeModel: ExecuteModelStep;
}

/** Connect agent calls to durable steps without requiring a ticket integration. */
export function bindAgentSteps(steps: AgentSteps) {
  function runAgent<T = undefined>(config: RunAgentOptions<T>) {
    return runAgentBlock(config, steps.executeAgent);
  }
  function askModel<T = undefined>(config: AskModelOptions<T>) {
    return askModelBlock(config, steps.executeModel);
  }
  return { runAgent, askModel };
}
