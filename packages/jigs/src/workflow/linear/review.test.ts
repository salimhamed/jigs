import { expect, test } from "vitest";
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

test("a note is recorded on the claim, so a later halt does not read it as a reply", async () => {
  const claim = {
    installationName: "linear-acme",
    issueId: "i1",
    postedCommentIds: [] as string[],
  } as TicketClaim;
  const posted: string[] = [];
  await noteOnTicket(
    claim,
    { headline: "h", notes: [], closing: "c" },
    {
      postTicketNote: async ({ installationName, issueId }) => {
        posted.push(`${installationName}:${issueId}`);
        return { commentId: "note-1" };
      },
    },
  );
  expect(posted).toEqual(["linear-acme:i1"]);
  expect(claim.postedCommentIds).toEqual(["note-1"]);
});
