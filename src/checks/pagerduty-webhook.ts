import { readFactoryConfig, type WebhooksConfig } from "../config/factory-config.ts";
import {
  missingWebhookSecret,
  webhookSecret,
  webhookSecretRepair,
} from "../config/webhook-secret.ts";
import { PagerDutyApiError, type PagerDutyWebhookSubscription } from "../providers/pagerduty.ts";
import type { Check, CheckResult } from "./catalog.ts";
import { RESTART_SERVICE } from "./core.ts";

/** The PagerDuty lookups the webhook check makes. */
export interface PagerDutyWebhookProbes {
  /** Mint, or reuse, the app's token; without one the identity check reports the failure. */
  token(): Promise<void>;
  subscriptions(url: string): Promise<PagerDutyWebhookSubscription[]>;
}

const CREATE =
  "in PagerDuty, add a Generic Webhook (v3) subscription under Integrations → Generic Webhooks (v3)";

export function pagerDutyWebhookChecks(options: {
  factoryRoot: () => string;
  probes: PagerDutyWebhookProbes;
}): Check[] {
  let webhooks: WebhooksConfig | undefined;
  try {
    ({ webhooks } = readFactoryConfig(options.factoryRoot()));
  } catch {
    // The binding catalog owns the single factory-config failure.
    return [];
  }
  // Off, incidents are polled and there is no subscription to have.
  if (webhooks === undefined || !webhooks.pagerduty?.enabled) return [];

  const url = `${webhooks.url.replace(/\/+$/, "")}/ingress/pagerduty`;
  return [
    {
      id: "pagerduty.webhook-secret",
      label: "PagerDuty webhook secret",
      run: async () => {
        const root = options.factoryRoot();
        return webhookSecret("pagerduty", root) !== undefined
          ? { ok: true }
          : {
              ok: false,
              reason: `webhooks.pagerduty is enabled but ${missingWebhookSecret("pagerduty", root)}`,
              repair: webhookSecretRepair("pagerduty", root),
            };
      },
    },
    {
      id: "pagerduty.webhook",
      label: "PagerDuty webhook",
      run: () => checkSubscription(url, options.probes),
    },
  ];
}

async function checkSubscription(
  url: string,
  probes: PagerDutyWebhookProbes,
): Promise<CheckResult> {
  try {
    await probes.token();
  } catch {
    return { ok: true, detail: "not checked: the PagerDuty identity check failed" };
  }
  let found: PagerDutyWebhookSubscription[];
  try {
    found = await probes.subscriptions(url);
  } catch (err) {
    const forbidden =
      err instanceof PagerDutyApiError && (err.status === 401 || err.status === 403);
    return {
      ok: false,
      reason: `could not list PagerDuty webhook subscriptions: ${err instanceof Error ? err.message : String(err)}`,
      repair: forbidden
        ? `grant webhook_subscriptions.read to the PagerDuty scoped OAuth app, then: \`${RESTART_SERVICE}\``
        : "PagerDuty did not answer: retry `pnpm exec jigs doctor`, and check PagerDuty's status page if it repeats",
    };
  }
  const triggered = found.filter((entry) => entry.events.includes("incident.triggered"));
  if (triggered.some((entry) => entry.active)) return { ok: true };
  if (triggered.length > 0) {
    // PagerDuty turns a subscription off after repeated failed deliveries.
    return {
      ok: false,
      reason: `the PagerDuty webhook subscription at ${url} is disabled`,
      repair: `enable it in PagerDuty under Integrations → Generic Webhooks (v3), or with \`POST /webhook_subscriptions/${triggered[0]?.id}/enable\` on the REST API`,
    };
  }
  return {
    ok: false,
    reason: `no PagerDuty webhook subscription sends incident.triggered to ${url}`,
    repair: `${CREATE} for the incident.triggered event on the service or team, delivering to ${url}; put its signing secret in .env as PAGERDUTY_WEBHOOK_SECRET`,
  };
}
