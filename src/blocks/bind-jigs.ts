import { type AgentSteps, bindAgentSteps } from "./agent/bind.ts";
import { bindPullRequestSteps } from "./pull-request/bind.ts";
import type { FetchPrState } from "./pull-request/gate.ts";
import { bindLinearSteps, type LinearSteps } from "./ticket/bind.ts";

export { type AgentSteps, bindAgentSteps } from "./agent/bind.ts";
export { bindPullRequestSteps } from "./pull-request/bind.ts";
export { type BoundReviewTicketOptions, bindLinearSteps, type LinearSteps } from "./ticket/bind.ts";

/** Durable steps used by all standard jigs blocks. */
export interface JigsSteps extends AgentSteps, Omit<LinearSteps, "agent"> {
  fetchPullRequestState: FetchPrState;
}

/** Connect all standard blocks; individual binders support smaller workflows. */
export function bindJigs(steps: JigsSteps) {
  const agents = bindAgentSteps(steps);
  return {
    ...agents,
    ...bindLinearSteps({ ...steps, agent: agents.agent }),
    ...bindPullRequestSteps(steps),
  };
}
