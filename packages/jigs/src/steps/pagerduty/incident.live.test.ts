import { afterAll, describe, expect, test, vi } from "vitest";
import {
  PAGERDUTY_API_URL,
  type PagerDutyIncident,
  pagerDutyFor,
} from "../../providers/pagerduty.ts";
import { livePagerDutyClient, waitForLiveIncident } from "../../providers/test-fixtures.ts";
import { fetchIncidentSnapshot } from "./fetch-snapshot.ts";
import { postIncidentNote } from "./notes.ts";

// The steps against a real test incident on the sandbox service, opened
// through the Events API and always resolved afterwards. Runs only with
// JIGS_TEST_PAGERDUTY_TOKEN (a PagerDuty app's token), PAGERDUTY_FROM and
// PAGERDUTY_EVENTS_ROUTING_KEY set.
vi.mock("../../providers/pagerduty.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../providers/pagerduty.ts")>()),
  pagerDutyFor: vi.fn(),
}));

const env = (name: string) => (process.env[name] === "" ? undefined : process.env[name]);
const from = env("PAGERDUTY_FROM");
const routingKey = env("PAGERDUTY_EVENTS_ROUTING_KEY");
const token = env("JIGS_TEST_PAGERDUTY_TOKEN");
const configured = token !== undefined && from !== undefined && routingKey !== undefined;
const SERVICE = env("PAGERDUTY_SERVICE_ID") ?? "P48FPG2";

describe.skipIf(!configured)("PagerDuty incident steps, live", () => {
  const client = livePagerDutyClient(token ?? "", from ?? "");
  vi.mocked(pagerDutyFor).mockReturnValue(client);

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
    return waitForLiveIncident(token ?? "", dedupKey);
  }

  test("reads the incident, then notes it once, naming the run", async () => {
    const incident = await openIncident();

    const snapshot = await fetchIncidentSnapshot({
      installationName: "pagerduty-live",
      incidentId: incident.id,
    });
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
    const { noteId } = await postIncidentNote(
      {
        installationName: "pagerduty-live",
        incidentId: incident.id,
        content: "jigs live test note.",
      },
      { workflowRunId: runId },
    );
    expect(noteId).toMatch(/^P/);

    const res = await fetch(`${PAGERDUTY_API_URL}/incidents/${incident.id}/notes`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.pagerduty+json;version=2",
      },
    });
    const { notes } = (await res.json()) as { notes: Array<{ id: string; content: string }> };
    const posted = notes.find((note) => note.id === noteId);
    expect(posted?.content).toBe(`jigs live test note.\n\nRun ${runId}`);
  });
});
