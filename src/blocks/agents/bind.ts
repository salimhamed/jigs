import { type ExecuteAgentStep, runAgent as runAgentBlock } from "./agent.ts";
import { askAgent as askAgentBlock } from "./ask-agent.ts";
import { askModel as askModelBlock, type ExecuteModelStep } from "./ask-model.ts";
import {
  type AskJevOptions,
  askJev as askJevBlock,
  type ExecuteJevStep,
  type JevQuestions,
} from "./jev.ts";
import type { AskAgentOptions, AskModelOptions, RunAgentOptions } from "./plan.ts";

export type { ExecuteJevStep } from "./jev.ts";

/**
 * The raw durable wrappers a factory supplies, one per execution role.
 *
 * @group Factory plumbing
 */
export interface AgentSteps {
  executeAgent: ExecuteAgentStep;
  executeModel: ExecuteModelStep;
  executeJev: ExecuteJevStep;
}

/**
 * Connect agent calls to durable steps without requiring a ticket integration.
 *
 * @group Factory plumbing
 */
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
  function askJev<const QUESTIONS extends JevQuestions>(config: AskJevOptions<QUESTIONS>) {
    return askJevBlock(config, steps.executeJev);
  }
  return { runAgent, askAgent, askModel, askJev };
}
