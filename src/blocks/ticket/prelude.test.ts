import { beforeEach, expect, test, vi } from "vitest";
import type { TicketSnapshot } from "./snapshot.ts";

const { createHook, getConflict } = vi.hoisted(() => ({
  createHook: vi.fn(),
  getConflict: vi.fn(async (): Promise<{ runId: string } | null> => null),
}));

vi.mock("workflow", () => ({ createHook }));

const { ClaimConflictError } = await import("./claim.ts");
const { acquireTicket } = await import("./prelude.ts");

const issue = { id: "issue-uuid", identifier: "AGE-471" };
const snapshot = { id: issue.id, identifier: issue.identifier } as TicketSnapshot;

beforeEach(() => {
  createHook.mockReset();
  getConflict.mockReset();
  getConflict.mockResolvedValue(null);
  createHook.mockImplementation(() => ({ getConflict }));
});

test("resolves, claims, and snapshots the resolved ticket in order", async () => {
  const calls: string[] = [];
  const resolveLinearIssue = vi.fn(async (reference: string) => {
    calls.push(`resolve:${reference}`);
    return issue;
  });
  createHook.mockImplementation(({ token }: { token: string }) => ({
    getConflict: async () => {
      calls.push(`claim:${token}`);
      return null;
    },
  }));
  const fetchTicketSnapshot = vi.fn(async (issueId: string) => {
    calls.push(`snapshot:${issueId}`);
    return snapshot;
  });

  const result = await acquireTicket("raw-reference", {
    resolveLinearIssue,
    fetchTicketSnapshot,
  });

  expect(result).toEqual({
    claim: expect.objectContaining({ issueId: issue.id, identifier: issue.identifier }),
    snapshot,
  });
  expect(calls).toEqual([
    "resolve:raw-reference",
    "claim:linear:ticket:issue-uuid",
    "snapshot:issue-uuid",
  ]);
  expect(createHook).toHaveBeenCalledWith({ token: "linear:ticket:issue-uuid" });
  expect(fetchTicketSnapshot).toHaveBeenCalledWith(issue.id);
});

test("does not fetch a snapshot when another run holds the ticket claim", async () => {
  getConflict.mockResolvedValue({ runId: "wrun_OWNER" });
  const fetchTicketSnapshot = vi.fn(async () => snapshot);

  await expect(
    acquireTicket("AGE-471", {
      resolveLinearIssue: vi.fn(async () => issue),
      fetchTicketSnapshot,
    }),
  ).rejects.toBeInstanceOf(ClaimConflictError);

  expect(fetchTicketSnapshot).not.toHaveBeenCalled();
});
