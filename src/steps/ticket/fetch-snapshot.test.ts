import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RawIssueSnapshot } from "../../providers/linear.ts";
import { fetchSnapshot } from "./fetch-snapshot.ts";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("LINEAR_API_KEY", "lin_test_key");
  vi.stubEnv("LINEAR_API_URL", "http://mock.test/graphql");
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const respond = (data: unknown) =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ data }), { status: 200 }),
  );

const comment = (id: string, body: string) => ({
  id,
  body,
  createdAt: "2026-08-26T12:00:00Z",
  user: { id: "u1", name: "salim" },
});

function rawIssue(overrides: Partial<RawIssueSnapshot> = {}): RawIssueSnapshot {
  return {
    id: "68bc9696-35d5-442d-ab56-214c8cfefbec",
    identifier: "AGE-313",
    title: "Ticket snapshot and the reviewTicket jig",
    description: "## Scope\n\nFetch the ticket on each activation.",
    url: "https://linear.app/x/issue/AGE-313",
    branchName: "salimhamed/age-313-ticket-snapshot",
    state: { name: "Todo" },
    labels: { nodes: [{ name: "ready-for-agent" }] },
    comments: { nodes: [comment("c1", "first pass looks right")] },
    attachments: { nodes: [{ title: "design doc", url: "https://doc.test" }] },
    children: { nodes: [{ id: "k1", identifier: "AGE-400", title: "sub" }] },
    relations: {
      nodes: [
        {
          type: "blocks",
          relatedIssue: {
            id: "b1",
            identifier: "AGE-318",
            title: "thin slice",
          },
        },
        {
          type: "related",
          relatedIssue: { id: "r1", identifier: "AGE-295", title: "authoring" },
        },
      ],
    },
    inverseRelations: {
      nodes: [
        {
          type: "blocks",
          issue: { id: "i1", identifier: "AGE-312", title: "suspensions" },
        },
      ],
    },
    ...overrides,
  };
}

test("a later fetch carries the new comment while the earlier copy keeps its own", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  respond({ issue: rawIssue() });
  respond({
    issue: rawIssue({
      comments: {
        nodes: [
          comment("c1", "first pass looks right"),
          comment("c2", "answering: yes, cap comments at 100"),
        ],
      },
    }),
  });

  const launch = await fetchSnapshot("68bc9696-35d5-442d-ab56-214c8cfefbec");
  const later = await fetchSnapshot("68bc9696-35d5-442d-ab56-214c8cfefbec");

  expect(launch.comments.map((c) => c.id)).toEqual(["c1"]);
  expect(later.comments.map((c) => c.id)).toEqual(["c1", "c2"]);
  expect(log).toHaveBeenNthCalledWith(
    1,
    "[snapshot] fetched issue=68bc9696-35d5-442d-ab56-214c8cfefbec identifier=AGE-313 state=Todo labels=ready-for-agent comments=1",
  );
  expect(log).toHaveBeenNthCalledWith(
    2,
    "[snapshot] fetched issue=68bc9696-35d5-442d-ab56-214c8cfefbec identifier=AGE-313 state=Todo labels=ready-for-agent comments=2",
  );
});
