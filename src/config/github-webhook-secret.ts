import path from "node:path";
import { factoryEnvValue } from "./factory-env.ts";

// The factory's `.env` is the only local copy of the secret GitHub signs repo
// webhook deliveries with, and jigs never generates it. Bind, doctor and the
// ingress all ask here whether it is configured.
export function githubWebhookSecret(factoryRoot?: string): string | undefined {
  // The service runs with `.env` already loaded, so it passes no root.
  if (factoryRoot !== undefined) return factoryEnvValue(factoryRoot, "GITHUB_WEBHOOK_SECRET");
  const value = process.env.GITHUB_WEBHOOK_SECRET;
  return value === undefined || value === "" ? undefined : value;
}

export function missingGithubWebhookSecret(factoryRoot: string): string {
  return `GITHUB_WEBHOOK_SECRET is not set in ${path.join(factoryRoot, ".env")}`;
}

export function githubWebhookSecretRepair(factoryRoot: string): string {
  return `generate one with \`openssl rand -hex 32\`, set it as GITHUB_WEBHOOK_SECRET in ${path.join(factoryRoot, ".env")} and restart the service (jigs service restart)`;
}
