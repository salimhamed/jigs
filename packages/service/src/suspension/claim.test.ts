import { beforeEach, expect, test, vi } from "vitest";

const { createHook, getConflict, dispose } = vi.hoisted(() => ({
  createHook: vi.fn(),
  getConflict: vi.fn(async () => null),
  dispose: vi.fn(),
}));

vi.mock("workflow", () => ({ createHook }));

const { claimTicket } = await import("./claim");

beforeEach(() => {
  createHook.mockReset();
  getConflict.mockClear();
  dispose.mockClear();
  createHook.mockImplementation(() => ({ getConflict, dispose }));
});

test.each([
  ["missing", undefined],
  ["empty", ""],
  ["non-string", 365],
])(
  "a %s identifier fails before creating a hook",
  async (_kind, identifier) => {
    await expect(
      claimTicket("68bc9696-35d5-442d-ab56-214c8cfefbec", identifier as string),
    ).rejects.toThrow(/identifier.*AGE-346/);
    expect(createHook).not.toHaveBeenCalled();
  },
);

test("valid arguments mint the UUID and identifier hooks", async () => {
  const issueId = "68bc9696-35d5-442d-ab56-214c8cfefbec";
  await expect(claimTicket(issueId, "AGE-365")).resolves.toMatchObject({
    issueId,
    identifier: "AGE-365",
    token: `linear:ticket:${issueId}`,
  });

  expect(createHook).toHaveBeenCalledTimes(2);
  expect(createHook.mock.calls.map(([options]) => options.token)).toEqual([
    `linear:ticket:${issueId}`,
    "linear:ticket:AGE-365",
  ]);
});
