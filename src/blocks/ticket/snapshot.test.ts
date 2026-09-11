import { expect, test } from "vitest";
import type { RawIssueSnapshot } from "../../providers/linear.ts";
import { renderSnapshot, toSnapshot } from "./snapshot.ts";

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

test("toSnapshot splits blocking relations, keeps links and sub-issues, and drops nothing else", () => {
  const snapshot = toSnapshot(rawIssue(), "2026-08-26T13:00:00Z");
  expect(snapshot.fetchedAt).toBe("2026-08-26T13:00:00Z");
  expect(snapshot.branchName).toBe("salimhamed/age-313-ticket-snapshot");
  expect(snapshot.state).toBe("Todo");
  expect(snapshot.labels).toEqual(["ready-for-agent"]);
  expect(snapshot.comments).toEqual([
    {
      id: "c1",
      body: "first pass looks right",
      createdAt: "2026-08-26T12:00:00Z",
      author: "salim",
    },
  ]);
  expect(snapshot.blocks.map((ref) => ref.identifier)).toEqual(["AGE-318"]);
  expect(snapshot.blockedBy.map((ref) => ref.identifier)).toEqual(["AGE-312"]);
  expect(snapshot.links).toEqual([
    { title: "design doc", url: "https://doc.test" },
  ]);
  expect(snapshot.subIssues.map((ref) => ref.identifier)).toEqual(["AGE-400"]);
});

test("a null description normalizes rather than leaking null into the prompt", () => {
  const snapshot = toSnapshot(
    rawIssue({ description: null }),
    "2026-08-26T13:00:00Z",
  );
  expect(snapshot.description).toBe("");
  expect(renderSnapshot(snapshot)).not.toContain("null");
});

test("renderSnapshot includes every section a reviewing agent needs", () => {
  const rendered = renderSnapshot(
    toSnapshot(rawIssue(), "2026-08-26T13:00:00Z"),
  );
  expect(rendered).toContain(
    "AGE-313 Ticket snapshot and the reviewTicket jig",
  );
  expect(rendered).toContain("Fetch the ticket on each activation.");
  expect(rendered).toContain("ready-for-agent");
  expect(rendered).toContain("first pass looks right");
  expect(rendered).toContain("## Blocked by");
  expect(rendered).toContain("AGE-312 suspensions");
  expect(rendered).toContain("## Blocks");
  expect(rendered).toContain("[design doc](https://doc.test)");
  expect(rendered).toContain("## Sub-issues");
  expect(rendered).toContain("AGE-400 sub");
});
