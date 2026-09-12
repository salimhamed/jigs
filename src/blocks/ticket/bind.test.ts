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
  runAgent: unused,
  postComment: unused,
  postNote: unused,
  checkForReply: unused,
  fetchTicketSnapshot: unused,
};

test("custom comment steps receive only serializable halt data and no step-object receiver", async () => {
  const claim = await claimTicket("issue-1", "AGE-1");
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
  const postComment = vi.fn<LinearSteps["postComment"]>(async function (
    this: unknown,
    issueId,
    received,
  ) {
    expect(this).toBeUndefined();
    expect(issueId).toBe("issue-1");
    expect(received).toBe(halt);
    expect(JSON.parse(JSON.stringify(received))).toEqual(halt);
    return { commentId: "posted", postedAt: "2026-09-11T00:00:00Z" };
  });
  const checkForReply = vi.fn<LinearSteps["checkForReply"]>(async () => ({
    reply,
    cursor: reply.createdAt,
  }));
  const linear = bindLinearSteps({ ...defaults, postComment, checkForReply });
  expect(await linear.haltForHuman(claim, halt)).toEqual(reply);
  expect(postComment).toHaveBeenCalledExactlyOnceWith("issue-1", halt);
  expect(checkForReply).toHaveBeenCalledExactlyOnceWith(
    "issue-1",
    "2026-09-11T00:00:00Z",
    "posted",
  );
});
