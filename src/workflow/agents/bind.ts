import { type ExecuteAgentStep, runAgent as runAgentRoutine } from "./agent.ts";
import { askAgent as askAgentRoutine } from "./ask-agent.ts";
import { askModel as askModelRoutine, type ExecuteModelStep } from "./ask-model.ts";
import { type DecideOptions, decide as decideRoutine } from "./decide.ts";
import {
  type AskJevOptions,
  askJev as askJevRoutine,
  type ExecuteJevStep,
  type JevQuestion,
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
    return runAgentRoutine(config, steps.executeAgent);
  }
  function askAgent<T = undefined>(config: AskAgentOptions<T>) {
    return askAgentRoutine(config, steps.executeAgent);
  }
  function askModel<T = undefined>(config: AskModelOptions<T>) {
    return askModelRoutine(config, steps.executeModel);
  }
  function askJev<const QUESTIONS extends JevQuestions>(config: AskJevOptions<QUESTIONS>) {
    return askJevRoutine(config, steps.executeJev);
  }
  function decide<const QUESTION extends JevQuestion>(config: DecideOptions<QUESTION>) {
    return decideRoutine(config, steps.executeJev);
  }
  return { runAgent, askAgent, askModel, askJev, decide };
}
