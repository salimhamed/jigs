vi.mock("#blocks/delivery/delivery", () => ({
  deliverChange: vi.fn(async () => ({
    change: {} as never,
    pr: { owner: "acme", repo: "repo", number: 1 },
  })),
}));

// The composition the unit tests cannot see: parsing an input, choosing a
// harness from it, and what deliverChange is actually handed. A model left
// unset has to arrive as the chosen harness's own default, and only running
// the workflow body against mocked durable steps shows that it does.
import { harnessKinds } from "@jigs-ai/jigs/blocks/agents";
import type { TicketClaim, TicketHandoff, TicketSnapshot } from "@jigs-ai/jigs/blocks/linear";
import { expect, test, vi } from "vitest";
import { z } from "zod";

vi.mock("#jigs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#jigs")>()),
  provisionWorktree: vi.fn(async () => ({
    path: "/tmp/ship-test",
    branch: "acme/abc-123",
    defaultBranch: "main",
    baseSha: "0".repeat(40),
  })),
  reviewTicket: vi.fn(async (): Promise<TicketHandoff> => handoff),
  setTicketStatus: vi.fn(async () => ({})),
  noteOnTicket: vi.fn(async () => {}),
  resolveMergePolicy: vi.fn(async () => ({
    by: "human" as const,
    method: "squash" as const,
    approval: { kind: "review" as const },
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
const handoff: TicketHandoff = { brief: "Do the thing.", snapshot, assumptions: [] };

const jigs = await import("#jigs");
const delivery = await import("#blocks/delivery/delivery");
const tickets = await import("#blocks/tickets/linear");
const { default: entry, shipInputs, shipWorkflow } = await import("./ship.ts");

async function deliveredFor(inputs: Record<string, unknown>) {
  vi.mocked(delivery.deliverChange).mockClear();
  vi.mocked(jigs.release).mockClear();
  vi.mocked(jigs.setTicketStatus).mockClear();
  vi.mocked(jigs.noteOnTicket).mockClear();
  vi.mocked(tickets.acquireLinearTicket).mockClear();
  await shipWorkflow({
    ...shipInputs.parse({ binding: "repo", ...inputs }),
    triggerId: "ship-test",
  });
  const options = vi.mocked(delivery.deliverChange).mock.calls[0]?.[0];
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

test("ship moves its ticket as the recipe progresses", async () => {
  const options = await deliveredFor({ ticket: "ABC-123" });
  expect(jigs.setTicketStatus).toHaveBeenCalledTimes(1);
  expect(jigs.setTicketStatus).toHaveBeenCalledWith(snapshot.id, "In Progress");
  expect(vi.mocked(jigs.setTicketStatus).mock.invocationCallOrder[0]).toBeGreaterThan(
    vi.mocked(tickets.acquireLinearTicket).mock.invocationCallOrder[0] ?? Infinity,
  );
  await options.on?.pullRequestOpened?.({ owner: "acme", repo: "repo", number: 1 });
  await options.on?.merged?.({ owner: "acme", repo: "repo", number: 1 });
  await options.on?.stopped?.("stopped short");
  expect(jigs.setTicketStatus).toHaveBeenCalledWith(snapshot.id, "In Review");
  expect(jigs.setTicketStatus).toHaveBeenCalledWith(snapshot.id, "Done");
  expect(jigs.setTicketStatus).toHaveBeenCalledWith(snapshot.id, "Todo");
  expect(jigs.noteOnTicket).toHaveBeenCalledWith(claim, {
    headline: "jigs finished work on ABC-123.",
    notes: ["Merged in acme/repo#1."],
    closing: "",
  });
});

test("a stopped delivery's note is posted through the ticket claim", async () => {
  const options = await deliveredFor({ ticket: "ABC-123" });
  const note = { headline: "jigs stopped work on ABC-123.", notes: ["open"], closing: "Retry." };
  await options.postNote(note);
  expect(jigs.noteOnTicket).toHaveBeenCalledWith(claim, note);
});

test("a successful delivery removes merged worktrees", async () => {
  await deliveredFor({ ticket: "ABC-123" });
  expect(jigs.release).toHaveBeenCalledOnce();
});

test("a delivery that stops short rejects without removing its worktree", async () => {
  vi.mocked(jigs.release).mockClear();
  vi.mocked(delivery.deliverChange).mockRejectedValueOnce(new Error("stopped short"));

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

test("the harness inputs list every registered harness kind", () => {
  const schema = z.toJSONSchema(shipInputs, { io: "input" }) as {
    properties: Record<string, { enum?: string[] }>;
  };
  expect(schema.properties.implementationHarness?.enum).toEqual(harnessKinds);
  expect(schema.properties.reviewHarness?.enum).toEqual(harnessKinds);
});

test("a pi role is refused at input validation with where to configure it", () => {
  for (const field of ["implementationHarness", "reviewHarness"]) {
    const parsed = shipInputs.safeParse({ ticket: "ABC-123", binding: "repo", [field]: "pi" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: [field],
        message:
          "ship cannot build a pi role from its inputs: pi roles need a model source and are configured in the ship workflow's own code",
      }),
    ]);
  }
});
