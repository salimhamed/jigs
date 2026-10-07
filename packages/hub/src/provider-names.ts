import type { Provider } from "@jigs-ai/hub-protocol";

/** How people know each provider, for the hub's pages and messages. */
export const providerNames: Record<Provider, string> = {
  github: "GitHub",
  linear: "Linear",
  slack: "Slack",
  pagerduty: "PagerDuty",
};
