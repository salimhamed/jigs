import { expect, test, vi } from "vitest";
import { pagerDutyFor } from "../../providers/pagerduty.ts";
import { postIncidentNote } from "./notes.ts";
import { recorded, recordedClient } from "./test-fixtures.ts";

vi.mock("../../providers/pagerduty.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../providers/pagerduty.ts")>()),
  pagerDutyFor: vi.fn(),
}));

test("posts plain text that ends in a line naming the run, and returns the note id", async () => {
  const note = recorded("note");
  const { client, calls } = recordedClient(() => ({ note }));
  vi.mocked(pagerDutyFor).mockReturnValue(client);

  const result = await postIncidentNote(
    {
      installationName: "pagerduty-acme",
      incidentId: "Q38Z72W5PMTIS1",
      content: "Checkout errors started at 06:20.\n",
    },
    { workflowRunId: "wrun_01KAB" },
  );

  expect(result).toEqual({ noteId: note.id });
  expect(calls).toHaveLength(1);
  const [call] = calls;
  expect(`${call?.method} ${call?.url.pathname}`).toBe("POST /incidents/Q38Z72W5PMTIS1/notes");
  expect(call?.headers.from).toBe("oncall@example.com");
  expect(call?.body).toEqual({
    note: { content: "Checkout errors started at 06:20.\n\njigs run wrun_01KAB" },
  });
});

test("the note carries no hidden marker", async () => {
  const { client, calls } = recordedClient(() => ({ note: recorded("note") }));
  vi.mocked(pagerDutyFor).mockReturnValue(client);

  await postIncidentNote(
    { installationName: "pagerduty-acme", incidentId: "Q1", content: "Looking into it." },
    { workflowRunId: "wrun_1" },
  );

  const [call] = calls;
  const content = (call?.body as { note: { content: string } } | undefined)?.note.content ?? "";
  expect(content).not.toMatch(/<!--|<sub>|jigs:v1/);
  expect(content.split("\n").at(-1)).toBe("jigs run wrun_1");
});
