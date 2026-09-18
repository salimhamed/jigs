import { type FetchPrState, type PullRequestGateFn, pullRequestGate } from "./gate.ts";

/** Connect pull-request waiting to the factory's durable state reader. */
export function bindPullRequestSteps(steps: { fetchPullRequestState: FetchPrState }) {
  const gate: PullRequestGateFn = (pr, scope, approval) =>
    pullRequestGate(pr, steps.fetchPullRequestState, scope, approval);
  return { pullRequestGate: gate };
}
