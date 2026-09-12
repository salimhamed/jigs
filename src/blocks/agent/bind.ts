import { agent as agentBlock, type RunAgentStep } from "./agent.ts";
import { ask as askBlock, type RunAskStep } from "./ask.ts";
import type { AgentStepConfig, AskStepConfig } from "./plan.ts";

export interface AgentSteps {
  runAgent: RunAgentStep;
  askModel: RunAskStep;
}

/** Connect agent calls to durable steps without requiring a ticket integration. */
export function bindAgentSteps(steps: AgentSteps) {
  function runAgent<T = undefined>(config: AgentStepConfig<T>) {
    return agentBlock(config, steps.runAgent);
  }
  function askModel<T = undefined>(config: AskStepConfig<T>) {
    return askBlock(config, steps.askModel);
  }
  return { runAgent, askModel, agent: runAgent, ask: askModel };
}
