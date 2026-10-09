import { expect, test, vi } from "vitest";
import type { TicketClaim } from "./claim.ts";
import { noteOnTicket, ticketReviewVerdictSchema } from "./review.ts";

test("a malformed verdict object fails the schema", () => {
  const good = {
    verdict: "proceed",
    brief: "x",
    about: "a",
    questions: [],
    assumptions: [],
  };
  expect(() => ticketReviewVerdictSchema.parse(good)).not.toThrow();
  expect(() => ticketReviewVerdictSchema.parse({ ...good, verdict: "maybe" })).toThrow();
  expect(() => ticketReviewVerdictSchema.parse({ ...good, brief: "" })).toThrow();
  expect(() => ticketReviewVerdictSchema.parse({ ...good, confidence: 0.8 })).toThrow();
  // A question is a question and up to three plain choices — nothing else.
  expect(() =>
    ticketReviewVerdictSchema.parse({
      ...good,
      questions: [{ question: "which?", options: [{ label: "a", why: "no" }] }],
    }),
  ).toThrow();
});

test("a note is posted in the claim's session", async () => {
  const claim = { installationName: "linear-acme", issueId: "i1", sessionId: "s1" } as TicketClaim;
  const postTicketNote = vi.fn(async () => {});
  const note = { headline: "h", notes: [], closing: "c", run: "ended" as const };
  await noteOnTicket(claim, note, { postTicketNote });
  expect(postTicketNote).toHaveBeenCalledExactlyOnceWith({
    installationName: "linear-acme",
    issueId: "i1",
    sessionId: "s1",
    note,
  });
});
