import { type ExecuteAgentStep, runAgent as runAgentBlock } from "./agent.ts";
import { askModel as askModelBlock, type ExecuteModelRequestStep } from "./ask-model.ts";
import type { AgentStepConfig, AskStepConfig } from "./plan.ts";

/** The raw durable wrappers a factory supplies, one per execution role. */
export interface AgentSteps {
  executeAgent: ExecuteAgentStep;
  executeModelRequest: ExecuteModelRequestStep;
}

/** Connect agent calls to durable steps without requiring a ticket integration. */
export function bindAgentSteps(steps: AgentSteps) {
  function runAgent<T = undefined>(config: AgentStepConfig<T>) {
    return runAgentBlock(config, steps.executeAgent);
  }
  function askModel<T = undefined>(config: AskStepConfig<T>) {
    return askModelBlock(config, steps.executeModelRequest);
  }
  return { runAgent, askModel };
}
