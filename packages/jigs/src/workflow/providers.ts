/** The outside services a factory reads from and writes to. */
export const PROVIDERS = ["github", "linear", "slack", "pagerduty"] as const;

/** One of {@link PROVIDERS}. */
export type Provider = (typeof PROVIDERS)[number];

// Slack delivers over Socket Mode, so it has no webhook or signing secret.
export type WebhookProvider = Exclude<Provider, "slack">;

export const WEBHOOK_PROVIDERS = PROVIDERS.filter(
  (provider): provider is WebhookProvider => provider !== "slack",
);

/** An object with one `value` per provider, for building per-provider config schemas. */
export function perProvider<P extends Provider, V>(
  providers: readonly P[],
  value: V,
): Record<P, V> {
  return Object.fromEntries(providers.map((provider) => [provider, value])) as Record<P, V>;
}
