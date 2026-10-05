import { afterAll, describe, expect, test } from "vitest";
import { livePagerDutyClient, waitForLiveIncident } from "./test-fixtures.ts";

// The live half of the PagerDuty client tests: a real PagerDuty app's token on
// a real account. Runs only with JIGS_TEST_PAGERDUTY_TOKEN and PAGERDUTY_FROM
// set; PAGERDUTY_EVENTS_ROUTING_KEY also opens and resolves a test incident on
// the sandbox service to add a note to.
const env = (name: string) => (process.env[name] === "" ? undefined : process.env[name]);
const token = env("JIGS_TEST_PAGERDUTY_TOKEN");
const from = env("PAGERDUTY_FROM");
const configured = token !== undefined && from !== undefined;
const routingKey = env("PAGERDUTY_EVENTS_ROUTING_KEY");

describe.skipIf(!configured)("PagerDuty, live", () => {
  const client = livePagerDutyClient(token ?? "", from ?? "");

  test("finds the from user", async () => {
    const user = await client.findUserByEmail(from ?? "");
    expect(user?.email.toLowerCase()).toBe(from?.toLowerCase());
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
      const incident = await waitForLiveIncident(token ?? "", dedupKey);
      expect((await client.getIncident(incident.id)).id).toBe(incident.id);
      const note = await client.createNote(incident.id, "jigs live test note");
      expect(note.content).toBe("jigs live test note");
      expect(note.user.id).toMatch(/^P/);
    });
  });
});
