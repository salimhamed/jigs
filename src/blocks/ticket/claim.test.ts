import { beforeEach, expect, test, vi } from "vitest";

const { createHook, getConflict, dispose } = vi.hoisted(() => ({
  createHook: vi.fn(),
  getConflict: vi.fn(async (): Promise<{ runId: string } | null> => null),
  dispose: vi.fn(),
}));

vi.mock("workflow", () => ({ createHook }));

const { claimTicket, ticketToken, tokenFromLinearPayload } = await import("./claim.ts");

beforeEach(() => {
  createHook.mockReset();
  getConflict.mockClear();
  dispose.mockClear();
  createHook.mockImplementation(() => ({ getConflict, dispose }));
});

test("a claim mints one hook, on the issue UUID, and carries the identifier", async () => {
  const issueId = "68bc9696-35d5-442d-ab56-214c8cfefbec";
  await expect(claimTicket(issueId, "AGE-365")).resolves.toMatchObject({
    issueId,
    identifier: "AGE-365",
    token: `linear:ticket:${issueId}`,
  });

  expect(createHook).toHaveBeenCalledTimes(1);
  expect(createHook.mock.calls.map(([options]) => options.token)).toEqual([
    `linear:ticket:${issueId}`,
  ]);
  expect(dispose).not.toHaveBeenCalled();
});

test("a conflicting claim names the owning run and mints nothing further", async () => {
  const issueId = "68bc9696-35d5-442d-ab56-214c8cfefbec";
  getConflict.mockResolvedValueOnce({ runId: "wrun_OWNER" });

  await expect(claimTicket(issueId, "AGE-365")).rejects.toThrow(
    `linear:ticket:${issueId} is already claimed by run wrun_OWNER`,
  );
  expect(createHook).toHaveBeenCalledTimes(1);
});

test("ticket token carries the UUID", () => {
  const issueId = "68bc9696-35d5-442d-ab56-214c8cfefbec";
  expect(ticketToken(issueId)).toBe(`linear:ticket:${issueId}`);
});

test("a linear Comment payload reconstructs the exact ticket token", () => {
  const issueId = "68bc9696-35d5-442d-ab56-214c8cfefbec";
  const payload = {
    action: "create",
    type: "Comment",
    data: { id: "comment-1", body: "looks good", issueId },
  };
  expect(tokenFromLinearPayload(payload)).toBe(ticketToken(issueId));
});

test("a non-Comment linear payload is unroutable", () => {
  expect(
    tokenFromLinearPayload({
      action: "update",
      type: "Issue",
      data: { id: "issue-1" },
    }),
  ).toBe(null);
  expect(tokenFromLinearPayload({ type: "Comment", data: {} })).toBe(null);
  expect(tokenFromLinearPayload(null)).toBe(null);
});
