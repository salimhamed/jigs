import { afterAll, describe, expect, test } from "vitest";
import type { PagerDutyIdentity } from "../config/factory-config.ts";
import { createPagerDutyClient, type PagerDutyIncident } from "./pagerduty.ts";
import { createPagerDutyAuth } from "./pagerduty-auth.ts";

// The live half of the PagerDuty client tests: a real scoped OAuth app on a
// real account. Runs only with PAGERDUTY_CLIENT_ID, PAGERDUTY_CLIENT_SECRET
// and PAGERDUTY_FROM set; PAGERDUTY_EVENTS_ROUTING_KEY also opens and resolves
// a test incident on the sandbox service to add a note to.
const env = (name: string) => (process.env[name] === "" ? undefined : process.env[name]);
const from = env("PAGERDUTY_FROM");
const configured =
  env("PAGERDUTY_CLIENT_ID") !== undefined &&
  env("PAGERDUTY_CLIENT_SECRET") !== undefined &&
  from !== undefined;
const routingKey = env("PAGERDUTY_EVENTS_ROUTING_KEY");
const SERVICE = env("PAGERDUTY_SERVICE_ID") ?? "P48FPG2";

describe.skipIf(!configured)("PagerDuty, live", () => {
  const identity: PagerDutyIdentity = {
    mode: "app",
    subdomain: env("PAGERDUTY_SUBDOMAIN") ?? "junglescout",
    region: env("PAGERDUTY_REGION") === "eu" ? "eu" : "us",
    from: from ?? "",
  };
  const auth = createPagerDutyAuth(identity, { env });
  const client = createPagerDutyClient(identity, { auth });

  test("mints a token and reuses it", async () => {
    const token = await auth.bearer();
    expect(token).not.toBe("");
    expect(await auth.bearer()).toBe(token);
  });

  test("lists the sandbox service's incidents", async () => {
    const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const incidents = await client.listIncidents({
      service_ids: [SERVICE],
      statuses: ["triggered", "acknowledged", "resolved"],
      since,
    });
    for (const incident of incidents) expect(incident.service.id).toBe(SERVICE);
  });

  test("lists webhook subscriptions without their secrets", async () => {
    const subscriptions = await client.listWebhookSubscriptions();
    for (const subscription of subscriptions) {
      expect(typeof subscription.delivery_method.url).toBe("string");
      expect(JSON.stringify(subscription)).not.toMatch(/"secret"\s*:\s*"[^"]/);
    }
  });

  test("finds the from user", async () => {
    const user = await client.findUserByEmail(identity.from);
    expect(user?.email.toLowerCase()).toBe(identity.from.toLowerCase());
  });

  describe.skipIf(routingKey === undefined)("a note on a test incident", () => {
    const dedupKey = `jigs-live-test-${crypto.randomUUID()}`;
    const enqueue = (action: "trigger" | "resolve") =>
      fetch("https://events.pagerduty.com/v2/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          routing_key: routingKey,
          event_action: action,
          dedup_key: dedupKey,
          ...(action === "trigger"
            ? {
                payload: {
                  summary: "jigs live test: safe to ignore, resolves itself",
                  source: "jigs pagerduty.live.test.ts",
                  severity: "info",
                },
              }
            : {}),
        }),
      });

    afterAll(async () => {
      await enqueue("resolve");
    });

    test("is attributed to the from user", async () => {
      expect((await enqueue("trigger")).status).toBe(202);
      let incident: PagerDutyIncident | undefined;
      for (let attempt = 0; attempt < 30 && incident === undefined; attempt += 1) {
        [incident] = await client.listIncidents({ incident_key: dedupKey });
        if (incident === undefined) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      if (incident === undefined) throw new Error("the test incident never appeared");
      expect((await client.getIncident(incident.id)).id).toBe(incident.id);
      const note = await client.createNote(incident.id, "jigs live test note");
      expect(note.content).toBe("jigs live test note");
      expect(note.user.id).toMatch(/^P/);
    });
  });
});
