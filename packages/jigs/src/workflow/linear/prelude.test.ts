import { beforeEach, expect, test, vi } from "vitest";
import type { TicketSnapshot } from "./snapshot.ts";

const { createHook, conflicts } = vi.hoisted(() => ({
  createHook: vi.fn(),
  conflicts: new Map<string, { runId: string }>(),
}));

vi.mock("workflow", () => ({ createHook }));

const { ClaimConflictError } = await import("./claim.ts");
const { acquireTicket } = await import("./prelude.ts");

const issue = { id: "issue-uuid", identifier: "AGE-471" };
const snapshot = { id: issue.id, identifier: issue.identifier } as TicketSnapshot;
const TICKET = "linear:ticket:linear-acme:issue-uuid";

let calls: string[];

const steps = () => ({
  resolveLinearIssue: vi.fn(async ({ reference }: { reference: string }) => {
    calls.push(`resolve:${reference}`);
    return issue;
  }),
  openLinearAgentSession: vi.fn(async ({ issueId }: { issueId: string }) => {
    calls.push(`open:${issueId}`);
    return { sessionId: "opened" };
  }),
  setLinearAgentSessionUrls: vi.fn(async ({ sessionId }: { sessionId: string }) => {
    calls.push(`urls:${sessionId}`);
  }),
  postLinearAgentActivity: vi.fn(async ({ sessionId }: { sessionId: string }) => {
    calls.push(`thought:${sessionId}`);
    return {};
  }),
  fetchTicketSnapshot: vi.fn(async ({ issueId }: { issueId: string }) => {
    calls.push(`snapshot:${issueId}`);
    return snapshot;
  }),
});

beforeEach(() => {
  calls = [];
  conflicts.clear();
  createHook.mockReset();
  createHook.mockImplementation(({ token }: { token: string }) => ({
    getConflict: async () => {
      calls.push(`hold:${token}`);
      return conflicts.get(token) ?? null;
    },
  }));
});

test("claims the ticket, opens and holds a session, says it is working, then snapshots", async () => {
  const s = steps();
  const result = await acquireTicket({ installationName: "linear-acme", reference: "AGE-471" }, s);

  expect(result).toEqual({
    claim: {
      installationName: "linear-acme",
      issueId: issue.id,
      identifier: issue.identifier,
      token: TICKET,
      sessionId: "opened",
      consumedPromptIds: [],
    },
    snapshot,
  });
  expect(calls).toEqual([
    "resolve:AGE-471",
    `hold:${TICKET}`,
    "open:issue-uuid",
    "hold:linear:session:linear-acme:opened",
    "thought:opened",
    "snapshot:issue-uuid",
  ]);
  expect(s.postLinearAgentActivity).toHaveBeenCalledWith({
    installationName: "linear-acme",
    sessionId: "opened",
    content: { type: "thought", body: "Working on AGE-471" },
  });
});

test("a run started from a session holds that session and links it instead of opening one", async () => {
  const s = steps();
  const { claim } = await acquireTicket(
    { installationName: "linear-acme", reference: "AGE-471", session: "given" },
    s,
  );
  expect(claim.sessionId).toBe("given");
  expect(calls).toEqual([
    "resolve:AGE-471",
    `hold:${TICKET}`,
    "hold:linear:session:linear-acme:given",
    "urls:given",
    "thought:given",
    "snapshot:issue-uuid",
  ]);
  expect(s.setLinearAgentSessionUrls).toHaveBeenCalledWith({
    installationName: "linear-acme",
    sessionId: "given",
    urls: [],
  });
});

test("a ticket another run holds fails before any session opens", async () => {
  conflicts.set(TICKET, { runId: "wrun_OWNER" });
  const s = steps();
  await expect(
    acquireTicket({ installationName: "linear-acme", reference: "AGE-471" }, s),
  ).rejects.toThrow(`Linear issue issue-uuid is already claimed by run wrun_OWNER`);
  expect(s.openLinearAgentSession).not.toHaveBeenCalled();
  expect(s.fetchTicketSnapshot).not.toHaveBeenCalled();
});

test("a session another run holds fails before the run posts in it", async () => {
  conflicts.set("linear:session:linear-acme:given", { runId: "wrun_CHAT" });
  const s = steps();
  await expect(
    acquireTicket({ installationName: "linear-acme", reference: "AGE-471", session: "given" }, s),
  ).rejects.toBeInstanceOf(ClaimConflictError);
  expect(s.setLinearAgentSessionUrls).not.toHaveBeenCalled();
  expect(s.postLinearAgentActivity).not.toHaveBeenCalled();
});
