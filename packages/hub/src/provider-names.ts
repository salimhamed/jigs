import type { Provider } from "@jigs-ai/hub-protocol";

/** How people know each provider, for the hub's pages and messages. */
export const providerNames: Record<Provider, string> = {
  github: "GitHub",
  linear: "Linear",
  slack: "Slack",
  pagerduty: "PagerDuty",
};

/** What each provider calls the app a hub uses, such as GitHub's GitHub App. */
export const providerAppTitles: Record<Provider, string> = {
  github: "GitHub App",
  linear: "Linear app",
  slack: "Slack app",
  pagerduty: "PagerDuty app",
};
