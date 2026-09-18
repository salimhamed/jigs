// The composition the unit tests cannot see: parsing an input, choosing a
// harness from it, and what deliverChange is actually handed. A model left
// unset has to arrive as the chosen harness's own default, and only running
// the workflow body against mocked durable steps shows that it does.
import type { Handoff, TicketClaim, TicketSnapshot } from "@salimhamed/jigs/linear";
import { expect, test, vi } from "vitest";

vi.mock("#jigs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#jigs")>()),
  provisionWorktree: vi.fn(async () => ({
    path: "/tmp/ship-test",
    branch: "acme/abc-123",
    defaultBranch: "main",
    baseSha: "0".repeat(40),
  })),
  reviewTicket: vi.fn(async (): Promise<Handoff> => handoff),
  resolveMergePolicy: vi.fn(async () => ({
    by: "human" as const,
    method: "squash" as const,
    approval: { kind: "review" as const },
  })),
  deliverChange: vi.fn(async () => ({
    change: {} as never,
    pr: { owner: "acme", repo: "repo", number: 1 },
  })),
  release: vi.fn(async () => {}),
}));

vi.mock("#blocks/tickets/linear", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#blocks/tickets/linear")>()),
  acquireLinearTicket: vi.fn(async () => ({ claim, snapshot })),
}));

const snapshot: TicketSnapshot = {
  fetchedAt: "2026-01-01T00:00:00.000Z",
  id: "11111111-1111-4111-8111-111111111111",
  identifier: "ABC-123",
  title: "Ship it",
  description: "Do the thing.",
  url: "https://linear.app/acme/issue/ABC-123",
  branchName: "acme/abc-123",
  state: "Todo",
  labels: [],
  comments: [],
  blockedBy: [],
  blocks: [],
  links: [],
  subIssues: [],
};

const claim = { issueId: snapshot.id, identifier: snapshot.identifier } as TicketClaim;
const handoff: Handoff = { brief: "Do the thing.", snapshot, assumptions: [] };

const jigs = await import("#jigs");
const { default: entry, shipInputs, shipWorkflow } = await import("./ship.ts");

async function deliveredFor(inputs: Record<string, unknown>) {
  vi.mocked(jigs.deliverChange).mockClear();
  vi.mocked(jigs.release).mockClear();
  await shipWorkflow({
    ...shipInputs.parse({ binding: "repo", ...inputs }),
    triggerId: "ship-test",
  });
  const options = vi.mocked(jigs.deliverChange).mock.calls[0]?.[0];
  if (options === undefined) throw new Error("deliverChange was never called");
  return options;
}

test("a harness chosen without a model reaches deliverChange as that harness's default", async () => {
  const claudeRun = await deliveredFor({ ticket: "ABC-123", implementationHarness: "claude" });
  expect(claudeRun.implementation.harness).toEqual({ kind: "claude", model: "opus" });

  const codexRun = await deliveredFor({ ticket: "ABC-123" });
  expect(codexRun.implementation.harness).toEqual({ kind: "codex", model: "gpt-5.6-sol" });
});

test("an explicit model overrides only the harness it was given for", async () => {
  const options = await deliveredFor({
    ticket: "ABC-123",
    implementationHarness: "claude",
    implementationModel: "sonnet",
  });
  expect(options.implementation.harness).toEqual({ kind: "claude", model: "sonnet" });
  expect(options.review.harness).toEqual({ kind: "claude", model: "opus" });
});

test("the work item delivered carries the ticket and the implementation brief", async () => {
  const options = await deliveredFor({ ticket: "ABC-123" });
  expect(options.task.key).toBe("ABC-123");
  expect(options.task.instructions).toContain("Implementation brief");
  expect(jigs.resolveMergePolicy).toHaveBeenCalledWith("repo");
});

test("a successful delivery removes merged worktrees", async () => {
  await deliveredFor({ ticket: "ABC-123" });
  expect(jigs.release).toHaveBeenCalledOnce();
});

test("a delivery that stops short rejects without removing its worktree", async () => {
  vi.mocked(jigs.release).mockClear();
  vi.mocked(jigs.deliverChange).mockRejectedValueOnce(new Error("stopped short"));

  await expect(
    shipWorkflow({
      ...shipInputs.parse({ binding: "repo", ticket: "ABC-123" }),
      triggerId: "ship-test",
    }),
  ).rejects.toThrow("stopped short");
  expect(jigs.release).not.toHaveBeenCalled();
});

test("ship accepts ticket identifiers and IDs and declares its integrations", () => {
  for (const ticket of ["ABC-123", crypto.randomUUID()]) {
    expect(entry.inputs.parse({ ticket, binding: "repo" })).toMatchObject({ ticket });
  }
  expect(entry.inputs.safeParse({ ticket: "", binding: "repo" }).success).toBe(false);
  expect(entry.requires).toEqual({
    harnesses: ["claude", "codex"],
    integrations: ["linear", "github"],
  });
});

test("omitted models stay unset until the workflow chooses harness defaults", () => {
  const parsed = shipInputs.parse({ ticket: "ABC-123", binding: "repo" });
  expect(parsed.implementationModel).toBeUndefined();
  expect(parsed.reviewModel).toBeUndefined();
});
