import path from "node:path";
import type { WebhookProvider } from "./factory-config.ts";
import { factoryEnvValue } from "./factory-env.ts";

const SECRET_VARIABLES: Record<WebhookProvider, string> = {
  github: "GITHUB_WEBHOOK_SECRET",
  linear: "LINEAR_WEBHOOK_SECRET",
};

/** The environment variable holding a provider's webhook signing secret. */
export function webhookSecretVariable(provider: WebhookProvider): string {
  return SECRET_VARIABLES[provider];
}

// The factory's `.env` is the only local copy of a provider's signing secret,
// and jigs never generates one. Bind, doctor, the boot gate and the ingress
// all ask here whether it is configured.
export function webhookSecret(provider: WebhookProvider, factoryRoot?: string): string | undefined {
  const variable = SECRET_VARIABLES[provider];
  // The service runs with `.env` already loaded, so it passes no root.
  if (factoryRoot !== undefined) return factoryEnvValue(factoryRoot, variable);
  const value = process.env[variable];
  return value === undefined || value === "" ? undefined : value;
}

export function missingWebhookSecret(provider: WebhookProvider, factoryRoot: string): string {
  return `${SECRET_VARIABLES[provider]} is not set in ${path.join(factoryRoot, ".env")}`;
}

export function webhookSecretRepair(provider: WebhookProvider, factoryRoot: string): string {
  const source =
    provider === "github"
      ? "generate one with `openssl rand -hex 32`"
      : "copy the signing secret from the Linear webhook's settings page";
  return `${source}, set it as ${SECRET_VARIABLES[provider]} in ${path.join(factoryRoot, ".env")} and restart the service (jigs service restart)`;
}
