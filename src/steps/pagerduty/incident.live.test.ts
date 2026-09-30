import { afterAll, describe, expect, test, vi } from "vitest";
import type { PagerDutyIdentity } from "../../config/factory-config.ts";
import {
  createPagerDutyClient,
  PAGERDUTY_API_URL,
  type PagerDutyIncident,
  pagerDutyClientFor,
} from "../../providers/pagerduty.ts";
import { createPagerDutyAuth } from "../../providers/pagerduty-auth.ts";
import { fetchIncidentSnapshot } from "./fetch-snapshot.ts";
import { postIncidentNote } from "./notes.ts";

// The steps against a real test incident on the sandbox service, opened
// through the Events API and always resolved afterwards. Runs only with
// PAGERDUTY_CLIENT_ID, PAGERDUTY_CLIENT_SECRET, PAGERDUTY_FROM and
// PAGERDUTY_EVENTS_ROUTING_KEY set.
vi.mock("../../providers/pagerduty.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../providers/pagerduty.ts")>()),
  pagerDutyClientFor: vi.fn(),
}));

const env = (name: string) => (process.env[name] === "" ? undefined : process.env[name]);
const from = env("PAGERDUTY_FROM");
const routingKey = env("PAGERDUTY_EVENTS_ROUTING_KEY");
const configured =
  env("PAGERDUTY_CLIENT_ID") !== undefined &&
  env("PAGERDUTY_CLIENT_SECRET") !== undefined &&
  from !== undefined &&
  routingKey !== undefined;
const SERVICE = env("PAGERDUTY_SERVICE_ID") ?? "P48FPG2";

describe.skipIf(!configured)("PagerDuty incident steps, live", () => {
  const identity: PagerDutyIdentity = {
    mode: "app",
    subdomain: env("PAGERDUTY_SUBDOMAIN") ?? "junglescout",
    region: env("PAGERDUTY_REGION") === "eu" ? "eu" : "us",
    from: from ?? "",
  };
  const auth = createPagerDutyAuth(identity, { env });
  const client = createPagerDutyClient(identity, { auth });
  vi.mocked(pagerDutyClientFor).mockReturnValue(client);

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
                source: "jigs incident.live.test.ts",
                severity: "info",
              },
            }
          : {}),
      }),
    });

  afterAll(async () => {
    await enqueue("resolve");
  });

  async function openIncident(): Promise<PagerDutyIncident> {
    expect((await enqueue("trigger")).status).toBe(202);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const [incident] = await client.listIncidents({ incident_key: dedupKey });
      if (incident !== undefined) return incident;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error("the test incident never appeared");
  }

  test("reads the incident, then notes it once, naming the run", async () => {
    const incident = await openIncident();

    const snapshot = await fetchIncidentSnapshot(incident.id);
    expect(snapshot).toMatchObject({
      id: incident.id,
      number: incident.incident_number,
      title: "jigs live test: safe to ignore, resolves itself",
      status: "triggered",
      service: { id: SERVICE },
    });
    expect(snapshot.url).toMatch(/^https:\/\/.+\.pagerduty\.com\/incidents\//);
    expect(snapshot.escalationPolicy.id).toMatch(/^P/);
    for (const assignee of snapshot.assignees) expect(assignee.id).toMatch(/^P/);

    const runId = `wrun_live_${dedupKey.slice(-8)}`;
    const { noteId } = await postIncidentNote(incident.id, "jigs live test note.", {
      workflowRunId: runId,
    });
    expect(noteId).toMatch(/^P/);

    const res = await fetch(`${PAGERDUTY_API_URL}/incidents/${incident.id}/notes`, {
      headers: {
        authorization: `Bearer ${await auth.bearer()}`,
        accept: "application/vnd.pagerduty+json;version=2",
      },
    });
    const { notes } = (await res.json()) as { notes: Array<{ id: string; content: string }> };
    const posted = notes.find((note) => note.id === noteId);
    expect(posted?.content).toBe(`jigs live test note.\n\njigs run ${runId}`);
  });
});
