import { expect, test, vi } from "vitest";
import type { LinearAgentPrompt } from "./agent-session.ts";
import { bindLinearSteps, type LinearSteps } from "./bind.ts";
import type { TicketClaim } from "./claim.ts";

vi.mock("workflow", () => ({
  createHook: () => ({
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
  listLinearAgentSessionPrompts: unused,
  postLinearAgentActivity: unused,
};
const claim = (): TicketClaim => ({
  installationName: "linear-acme",
  issueId: "issue-1",
  identifier: "AGE-1",
  token: "linear:ticket:linear-acme:issue-1",
  sessionId: "session-1",
  consumedPromptIds: [],
});
const prompt: LinearAgentPrompt = {
  id: "p1",
  createdAt: "2026-09-11T00:00:01Z",
  body: "continue",
  signal: null,
  author: { id: "user", name: "Human" },
  sourceCommentId: "c1",
};

test("custom steps receive only serializable halt data and no step-object receiver", async () => {
  const halt = { headline: "Need a choice", where: "review", onReply: "continue" as const };
  const postTicketHumanInputRequest = vi.fn<LinearSteps["postTicketHumanInputRequest"]>(
    async function (this: unknown, request) {
      expect(this).toBeUndefined();
      expect(JSON.parse(JSON.stringify(request))).toEqual({
        installationName: "linear-acme",
        issueId: "issue-1",
        sessionId: "session-1",
        halt,
      });
    },
  );
  const linear = bindLinearSteps({
    ...defaults,
    postTicketHumanInputRequest,
    listLinearAgentSessionPrompts: async function (this: unknown) {
      expect(this).toBeUndefined();
      return [prompt];
    },
    postLinearAgentActivity: async function (this: unknown) {
      expect(this).toBeUndefined();
      return {};
    },
  });
  expect(await linear.haltForHuman(claim(), halt)).toEqual({
    body: "continue",
    author: prompt.author,
    createdAt: prompt.createdAt,
  });
  expect(postTicketHumanInputRequest).toHaveBeenCalledOnce();
});

test("a note goes to the claim's session through the factory's step", async () => {
  const postTicketNote = vi.fn<LinearSteps["postTicketNote"]>(async () => {});
  const linear = bindLinearSteps({ ...defaults, postTicketNote });
  const note = { headline: "Starting.", notes: [], closing: "" };
  await linear.noteOnTicket(claim(), note);
  expect(postTicketNote).toHaveBeenCalledExactlyOnceWith({
    installationName: "linear-acme",
    issueId: "issue-1",
    sessionId: "session-1",
    note,
  });
});
