import { expect, test, vi } from "vitest";
import { pagerDutyFor } from "../../providers/pagerduty.ts";
import { fetchIncidentSnapshot } from "./fetch-snapshot.ts";
import { recorded, recordedClient } from "./test-fixtures.ts";

vi.mock("../../providers/pagerduty.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../providers/pagerduty.ts")>()),
  pagerDutyFor: vi.fn(),
}));

test("reads the incident once and keeps the fields a triage orients on", async () => {
  const incident = recorded("incident");
  const { client, calls } = recordedClient(() => ({ incident }));
  vi.mocked(pagerDutyFor).mockReturnValue(client);

  const snapshot = await fetchIncidentSnapshot({
    installationName: "pagerduty-acme",
    incidentId: incident.id,
  });

  expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
    `GET /incidents/${incident.id}`,
  ]);
  expect(snapshot).toEqual({
    fetchedAt: expect.any(String),
    id: "Q38Z72W5PMTIS1",
    number: 19831,
    title: "jigs live test: safe to ignore, resolves itself",
    status: "triggered",
    urgency: "high",
    createdAt: incident.created_at,
    url: "https://acme.pagerduty.com/incidents/Q38Z72W5PMTIS1",
    service: {
      id: "P48FPG2",
      name: "jigs-sandbox",
      url: "https://acme.pagerduty.com/service-directory/P48FPG2",
    },
    assignees: [
      {
        id: "PXNA3IV",
        name: "Example Responder",
        url: "https://acme.pagerduty.com/users/PXNA3IV",
      },
    ],
    escalationPolicy: {
      id: "PWRV0RR",
      name: "jigs-sandbox",
      url: "https://acme.pagerduty.com/escalation_policies/PWRV0RR",
    },
  });
  expect(Number.isNaN(Date.parse(snapshot.fetchedAt))).toBe(false);
});

test("an unassigned incident has no assignees, and a reference without a summary falls back to its id", async () => {
  const incident = {
    ...recorded("incident"),
    assignments: [],
    escalation_policy: { id: "PWRV0RR", type: "escalation_policy_reference" },
  };
  vi.mocked(pagerDutyFor).mockReturnValue(recordedClient(() => ({ incident })).client);

  const snapshot = await fetchIncidentSnapshot({
    installationName: "pagerduty-acme",
    incidentId: incident.id,
  });

  expect(snapshot.assignees).toEqual([]);
  expect(snapshot.escalationPolicy).toEqual({ id: "PWRV0RR", name: "PWRV0RR", url: null });
});
