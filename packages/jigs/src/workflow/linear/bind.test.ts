import { expect, test, vi } from "vitest";
import { bindLinearSteps, type LinearSteps } from "./bind.ts";
import { claimTicket } from "./claim.ts";

vi.mock("workflow", () => ({
  createHook: () => ({
    getConflict: async () => null,
    dispose: () => {},
    async *[Symbol.asyncIterator]() {
      yield {};
    },
  }),
}));

const unused = async (): Promise<never> => {
  throw new Error("unexpected step");
};
const defaults: LinearSteps = {
  postTicketHumanInputRequest: unused,
  postTicketNote: unused,
  checkForTicketHumanReply: unused,
};

test("custom comment steps receive only serializable halt data and no step-object receiver", async () => {
  const claim = await claimTicket({
    installationName: "linear-acme",
    issueId: "issue-1",
    identifier: "AGE-1",
  });
  const halt = {
    headline: "Need a choice",
    where: "review",
    onReply: "continue" as const,
  };
  const reply = {
    commentId: "reply",
    body: "continue",
    author: { id: "user", name: "Human" },
    createdAt: "2026-09-11T00:00:01Z",
  };
  const postTicketHumanInputRequest = vi.fn<LinearSteps["postTicketHumanInputRequest"]>(
    async function (this: unknown, request) {
      expect(this).toBeUndefined();
      expect(request.halt).toBe(halt);
      expect(JSON.parse(JSON.stringify(request))).toEqual({
        installationName: "linear-acme",
        issueId: "issue-1",
        halt,
      });
      return { commentId: "posted", postedAt: "2026-09-11T00:00:00Z" };
    },
  );
  const checkForTicketHumanReply = vi.fn<LinearSteps["checkForTicketHumanReply"]>(async () => ({
    reply,
    cursor: reply.createdAt,
  }));
  const linear = bindLinearSteps({
    ...defaults,
    postTicketHumanInputRequest,
    checkForTicketHumanReply,
  });
  expect(await linear.haltForHuman(claim, halt)).toEqual(reply);
  expect(postTicketHumanInputRequest).toHaveBeenCalledExactlyOnceWith({
    installationName: "linear-acme",
    issueId: "issue-1",
    halt,
  });
  expect(checkForTicketHumanReply).toHaveBeenCalledExactlyOnceWith({
    installationName: "linear-acme",
    issueId: "issue-1",
    since: "2026-09-11T00:00:00Z",
    postedCommentIds: ["posted"],
  });
});

test("a note posted through the claim is skipped when a later halt looks for a reply", async () => {
  const claim = await claimTicket({
    installationName: "linear-acme",
    issueId: "issue-1",
    identifier: "AGE-1",
  });
  const checkForTicketHumanReply = vi.fn<LinearSteps["checkForTicketHumanReply"]>(async () => ({
    reply: { commentId: "reply", body: "ok", author: { id: "u", name: "H" }, createdAt: "t2" },
    cursor: "t2",
  }));
  const linear = bindLinearSteps({
    ...defaults,
    postTicketNote: async () => ({ commentId: "note" }),
    postTicketHumanInputRequest: async () => ({ commentId: "question", postedAt: "t1" }),
    checkForTicketHumanReply,
  });
  await linear.noteOnTicket(claim, { headline: "Starting.", notes: [], closing: "" });
  await linear.haltForHuman(claim, { headline: "Which?", where: "review", onReply: "continue" });
  expect(checkForTicketHumanReply).toHaveBeenCalledExactlyOnceWith({
    installationName: "linear-acme",
    issueId: "issue-1",
    since: "t1",
    postedCommentIds: ["note", "question"],
  });
});
