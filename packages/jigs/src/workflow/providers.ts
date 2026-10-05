/** The outside services a factory reads from and writes to. */
export const PROVIDERS = ["github", "linear", "slack", "pagerduty"] as const;

/** One of {@link PROVIDERS}. */
export type Provider = (typeof PROVIDERS)[number];

// GitHub reaches the factory only through its hub, so the service never polls it.
export type PolledProvider = Exclude<Provider, "github">;

export const POLLED_PROVIDERS = PROVIDERS.filter(
  (provider): provider is PolledProvider => provider !== "github",
);

// Only PagerDuty still sends its webhooks to the factory's own service.
export type WebhookProvider = "pagerduty";

export const WEBHOOK_PROVIDERS: readonly WebhookProvider[] = ["pagerduty"];

/** An object with one `value` per provider, for building per-provider config schemas. */
export function perProvider<P extends Provider, V>(
  providers: readonly P[],
  value: V,
): Record<P, V> {
  return Object.fromEntries(providers.map((provider) => [provider, value])) as Record<P, V>;
}
