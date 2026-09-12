import { expect, test, vi } from "vitest";
import { z } from "zod";
import { claude } from "./agent/harness-config.ts";
import { bindJigs, type JigsSteps } from "./bind-jigs.ts";

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
const defaults: JigsSteps = {
  runAgent: unused,
  askModel: unused,
  postNeedsHumanComment: unused,
  postTicketNote: unused,
  checkForHumanReply: unused,
  fetchPullRequestState: unused,
  fetchTicketSnapshot: unused,
};

test("a factory can override a named step and retain typed output parsing", async () => {
  const askModel = vi.fn<JigsSteps["askModel"]>(async () => ({
    text: "",
    output: { count: 3 },
  }));
  const custom = bindJigs({ ...defaults, askModel });
  const result = await custom.ask({
    harness: claude({ model: "sonnet" }),
    prompt: "Count",
    output: z.object({ count: z.number() }),
  });
  expect(result.output.count).toBe(3);
  expect(askModel).toHaveBeenCalledOnce();

  askModel.mockResolvedValueOnce({ text: "", output: { count: "invalid" } });
  await expect(
    custom.ask({
      harness: claude({ model: "sonnet" }),
      prompt: "Count",
      output: z.object({ count: z.number() }),
    }),
  ).rejects.toThrow();
});

test("custom comment steps receive only serializable halt data and no step-object receiver", async () => {
  const { claimTicket } = await import("./ticket/claim.ts");
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
  const postNeedsHumanComment = vi.fn<JigsSteps["postNeedsHumanComment"]>(
    async function (this: unknown, issueId, received) {
      expect(this).toBeUndefined();
      expect(issueId).toBe("issue-1");
      expect(received).toBe(halt);
      expect(JSON.parse(JSON.stringify(received))).toEqual(halt);
      return { commentId: "posted", postedAt: "2026-09-11T00:00:00Z" };
    },
  );
  const checkForHumanReply = vi.fn<JigsSteps["checkForHumanReply"]>(
    async () => ({ reply, cursor: reply.createdAt }),
  );
  const custom = bindJigs({
    ...defaults,
    postNeedsHumanComment,
    checkForHumanReply,
  });
  expect(await custom.haltForHuman(claim, halt)).toEqual(reply);
  expect(postNeedsHumanComment).toHaveBeenCalledExactlyOnceWith(
    "issue-1",
    halt,
  );
  expect(checkForHumanReply).toHaveBeenCalledExactlyOnceWith(
    "issue-1",
    "2026-09-11T00:00:00Z",
    "posted",
  );
});
