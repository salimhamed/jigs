import {
  type LinearIdentity,
  readFactoryConfig,
  type WebhooksConfig,
} from "../config/factory-config.ts";
import {
  missingWebhookSecret,
  webhookSecret,
  webhookSecretRepair,
} from "../config/webhook-secret.ts";
import { type LinearWebhook, listWebhooks } from "../providers/linear.ts";
import type { Check, CheckResult } from "./catalog.ts";

export interface LinearWebhookChecksOptions {
  factoryRoot: () => string;
  list?: () => Promise<LinearWebhook[]>;
}

export function linearWebhookChecks(options: LinearWebhookChecksOptions): Check[] {
  let webhooks: WebhooksConfig | undefined;
  let identity: LinearIdentity;
  try {
    ({
      webhooks,
      linear: { identity },
    } = readFactoryConfig(options.factoryRoot()));
  } catch {
    // The binding catalog owns the single factory-config failure.
    return [];
  }
  // Off, ticket halts are polled and there is no Linear webhook to have.
  if (webhooks === undefined || !webhooks.linear.enabled) return [];

  const url = `${webhooks.url.replace(/\/+$/, "")}/ingress/linear`;
  return [
    {
      id: "linear.webhook-secret",
      label: "Linear webhook secret",
      run: async () => {
        const root = options.factoryRoot();
        return webhookSecret("linear", root) !== undefined
          ? { ok: true }
          : {
              ok: false,
              reason: `webhooks.linear is enabled but ${missingWebhookSecret("linear", root)}`,
              repair: webhookSecretRepair("linear", root),
            };
      },
    },
    {
      id: "linear.webhook",
      label: "Linear webhook",
      run: async () =>
        // Listing webhooks needs the admin scope, which Linear never grants an
        // app actor, and a second admin credential just for this was rejected.
        identity.mode === "app"
          ? {
              ok: true,
              detail: `not verified: listing webhooks needs the admin scope, which an app actor cannot hold. Confirm a Comment webhook exists at ${url} in Linear settings.`,
            }
          : checkLinearWebhook(url, options.list ?? listWebhooks),
    },
  ];
}

async function checkLinearWebhook(
  url: string,
  list: () => Promise<LinearWebhook[]>,
): Promise<CheckResult> {
  let webhooks: LinearWebhook[];
  try {
    webhooks = await list();
  } catch (err) {
    return {
      ok: false,
      reason: `Linear could not list webhooks: ${err}`,
      repair:
        "use a Linear admin API key that can read webhooks, or verify the webhook in Linear settings",
    };
  }

  const webhook = webhooks.find((candidate) => candidate.url === url);
  if (webhook?.enabled) return { ok: true };
  if (webhook !== undefined) {
    return {
      ok: false,
      reason: `the Linear webhook at ${url} is disabled`,
      repair: `re-enable the webhook at ${url} in Linear settings`,
    };
  }

  const otherHosts = webhooks
    .filter((candidate) => {
      try {
        return new URL(candidate.url).pathname === "/ingress/linear";
      } catch {
        return false;
      }
    })
    .map((candidate) => new URL(candidate.url).host);
  const stale =
    otherHosts.length === 0
      ? ""
      : ` Other /ingress/linear webhook hosts: ${[...new Set(otherHosts)].join(", ")}. Repoint or delete a stale webhook by hand.`;
  return {
    ok: false,
    reason: `no Linear webhook exists at ${url}`,
    repair: `create the webhook at ${url} in Linear settings with resource type Comment.${stale}`,
  };
}
