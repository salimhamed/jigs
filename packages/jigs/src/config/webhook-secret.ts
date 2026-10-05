import path from "node:path";
import type { WebhookProvider } from "../workflow/providers.ts";
import type { FactoryContext } from "./factory-context.ts";

const SECRET_VARIABLES: Record<WebhookProvider, string> = {
  pagerduty: "PAGERDUTY_WEBHOOK_SECRET",
};

const SECRET_SOURCES: Record<WebhookProvider, string> = {
  // PagerDuty shows it once, when the subscription is created.
  pagerduty:
    "copy the signing secret PagerDuty showed when the webhook subscription was created, or create the subscription again for a new one",
};

/** The environment variable holding a provider's webhook signing secret. */
export function webhookSecretVariable(provider: WebhookProvider): string {
  return SECRET_VARIABLES[provider];
}

// The factory's `.env` is the only local copy of a provider's signing secret,
// and jigs never generates one. Bind, doctor, the boot gate and the ingress
// all ask here whether it is configured.
export function webhookSecret(
  provider: WebhookProvider,
  ctx: Pick<FactoryContext, "env">,
): string | undefined {
  return ctx.env(SECRET_VARIABLES[provider]);
}

export function missingWebhookSecret(provider: WebhookProvider, factoryRoot: string): string {
  return `${SECRET_VARIABLES[provider]} is not set in ${path.join(factoryRoot, ".env")}`;
}

export function webhookSecretRepair(provider: WebhookProvider, factoryRoot: string): string {
  return `${SECRET_SOURCES[provider]}\nset it as ${SECRET_VARIABLES[provider]} in ${path.join(factoryRoot, ".env")}\nrestart the service: \`pnpm exec jigs service restart\``;
}
