import { type FetchPrState, type GateFn, pullRequestGate } from "./gate.ts";

/** Connect pull-request waiting to the factory's durable state reader. */
export function bindPullRequestSteps(steps: { fetchPullRequestState: FetchPrState }) {
  const gate: GateFn = (pr) => pullRequestGate(pr, steps.fetchPullRequestState);
  return { pullRequestGate: gate };
}
