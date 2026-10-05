/** The outside services a factory reads from and writes to. */
export const PROVIDERS = ["github", "linear", "slack", "pagerduty"] as const;

/** One of {@link PROVIDERS}. */
export type Provider = (typeof PROVIDERS)[number];
