import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { resolveFactoryContext } from "../config/factory-context.ts";
import { ProviderApiError } from "./http.ts";
import type { PagerDutyWebhookSubscription } from "./pagerduty.ts";
import { type PagerDutyWebhookProbes, pagerDutyWebhookChecks } from "./pagerduty-webhook-checks.ts";

const roots: string[] = [];
const URL_AT = "https://factory.example.test/ingress/pagerduty";

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function factoryWith(pagerduty: unknown): string {
  const root = mkdtempSync(path.join(tmpdir(), "jigs-pagerduty-webhook-"));
  roots.push(root);
  const webhooks = {
    url: "https://factory.example.test/",
    pagerduty,
  };
  writeFileSync(
    path.join(root, "jigs.config.ts"),
    `export default ${JSON.stringify({ service: { dashboardPort: 8991 }, workflows: {}, webhooks })};`,
  );
  return root;
}

const subscription = (
  fields: Partial<PagerDutyWebhookSubscription> = {},
): PagerDutyWebhookSubscription => ({
  id: "PSUB001",
  active: true,
  events: ["incident.triggered"],
  delivery_method: { type: "http_delivery_method", url: URL_AT },
  filter: { type: "service_reference", id: "PSVC001" },
  ...fields,
});

function checks(
  subscriptions: PagerDutyWebhookProbes["subscriptions"],
  pagerduty: unknown = { enabled: true },
  token: PagerDutyWebhookProbes["token"] = async () => {},
) {
  vi.stubEnv("PAGERDUTY_WEBHOOK_SECRET", "pd-secret");
  const root = factoryWith(pagerduty);
  return pagerDutyWebhookChecks({
    context: resolveFactoryContext(root),
    probes: { token, subscriptions },
  });
}

const run = (...args: Parameters<typeof checks>) =>
  checks(...args)
    .find((check) => check.id === "pagerduty.webhook")
    ?.run();

test("off, there is nothing to check", () => {
  expect(checks(async () => [], { enabled: false })).toEqual([]);
});

test("an active incident.triggered subscription at the ingress URL passes", async () => {
  const subscriptions = vi.fn(async () => [subscription()]);
  expect(await run(subscriptions)).toEqual({ ok: true });
  expect(subscriptions).toHaveBeenCalledWith(URL_AT);
});

test("a subscription PagerDuty disabled says how to enable it again", async () => {
  expect(await run(async () => [subscription({ active: false })])).toMatchObject({
    ok: false,
    reason: `the PagerDuty webhook subscription at ${URL_AT} is disabled`,
    repair: expect.stringContaining("POST /webhook_subscriptions/PSUB001/enable"),
  });
});

test("no subscription, or one without incident.triggered, says how to create it", async () => {
  for (const found of [[], [subscription({ events: ["incident.resolved"] })]])
    expect(await run(async () => found)).toMatchObject({
      ok: false,
      reason: `no PagerDuty webhook subscription sends incident.triggered to ${URL_AT}`,
      repair: expect.stringContaining("Generic Webhooks (v3)"),
    });
});

test("a refused listing names the scope, and a failed token defers to the identity check", async () => {
  expect(
    await run(async () => {
      throw new ProviderApiError({
        provider: "pagerduty",
        status: 403,
        request: "GET /webhook_subscriptions",
        body: "forbidden",
      });
    }),
  ).toMatchObject({ ok: false, repair: expect.stringContaining("webhook_subscriptions.read") });
  expect(
    await run(
      async () => [],
      { enabled: true },
      async () => {
        throw new Error("no token");
      },
    ),
  ).toMatchObject({ ok: true, detail: expect.stringContaining("not checked") });
});

test("an enabled webhook without its secret fails", async () => {
  const list = checks(async () => []);
  vi.stubEnv("PAGERDUTY_WEBHOOK_SECRET", "");
  const secret = list.find((check) => check.id === "pagerduty.webhook-secret");
  expect(await secret?.run()).toMatchObject({
    ok: false,
    reason: expect.stringContaining("PAGERDUTY_WEBHOOK_SECRET is not set"),
  });
});
