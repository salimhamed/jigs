import type { Check, CheckResult } from "../checks/check.ts";
import type { FactoryContext } from "../config/factory-context.ts";
import {
  missingWebhookSecret,
  webhookSecret,
  webhookSecretRepair,
} from "../config/webhook-secret.ts";
import type { LinearIdentity, WebhooksConfig } from "../workflow/factory-schema.ts";
import { type LinearWebhook, listWebhooks } from "./linear.ts";

export interface LinearWebhookChecksOptions {
  context: FactoryContext;
  list?: () => Promise<LinearWebhook[]>;
}

export function linearWebhookChecks(options: LinearWebhookChecksOptions): Check[] {
  const ctx = options.context;
  let webhooks: WebhooksConfig | undefined;
  let identity: LinearIdentity;
  try {
    ({
      webhooks,
      linear: { identity },
    } = ctx.config);
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
        return webhookSecret("linear", ctx) !== undefined
          ? { ok: true }
          : {
              ok: false,
              reason: `webhooks.linear is enabled but ${missingWebhookSecret("linear", ctx.root)}`,
              repair: webhookSecretRepair("linear", ctx.root),
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
