import { beforeEach, expect, test, vi } from "vitest";
import type { LinearAgentPrompt } from "./agent-session.ts";
import type { TicketClaim } from "./claim.ts";
import { type Halt, type HaltForHumanDependencies, haltForHuman } from "./halt-for-human.ts";

const { createHook, hook } = vi.hoisted(() => ({
  createHook: vi.fn(),
  hook: { wakes: 0, disposed: [] as string[] },
}));

vi.mock("workflow", () => ({ createHook }));

const LISTENING = "linear:listening:linear-acme:session-1";
const HALT: Halt = { headline: "Which way?", where: "review", onReply: "continue" };

const prompt = (id: string, body: string, extra: Partial<LinearAgentPrompt> = {}) => ({
  id,
  createdAt: `2026-10-07T10:0${id.slice(1)}:00Z`,
  body,
  signal: null,
  author: { id: "u1", name: "Ada" },
  sourceCommentId: `c-${id}`,
  ...extra,
});

let claim: TicketClaim;
let reads: LinearAgentPrompt[][];
let deps: HaltForHumanDependencies & {
  [K in keyof HaltForHumanDependencies]: ReturnType<typeof vi.fn>;
};
let order: string[];

beforeEach(() => {
  claim = {
    installationName: "linear-acme",
    issueId: "issue-1",
    identifier: "AGE-1",
    token: "linear:ticket:linear-acme:issue-1",
    sessionId: "session-1",
    consumedPromptIds: [],
  };
  reads = [];
  order = [];
  Object.assign(hook, { wakes: 0, disposed: [] });
  createHook.mockReset();
  createHook.mockImplementation(({ token }: { token: string }) => {
    order.push(`hook:${token}`);
    return {
      dispose: () => hook.disposed.push(token),
      async *[Symbol.asyncIterator]() {
        for (;;) {
          hook.wakes += 1;
          yield undefined;
        }
      },
    };
  });
  deps = {
    postTicketHumanInputRequest: vi.fn(async () => {
      order.push("ask");
    }),
    listLinearAgentSessionPrompts: vi.fn(async () => reads.shift() ?? []),
    postLinearAgentActivity: vi.fn(async () => ({})),
  };
});

test("listens before asking, waits through empty wakes, then takes the reply and goes on", async () => {
  reads = [[], [], [prompt("p1", "left")]];
  const reply = await haltForHuman(claim, HALT, deps);

  expect(reply).toEqual({
    body: "left",
    author: { id: "u1", name: "Ada" },
    createdAt: "2026-10-07T10:01:00Z",
  });
  expect(order).toEqual([`hook:${LISTENING}`, "ask"]);
  expect(deps.postTicketHumanInputRequest).toHaveBeenCalledExactlyOnceWith({
    installationName: "linear-acme",
    issueId: "issue-1",
    sessionId: "session-1",
    halt: HALT,
  });
  expect(hook.wakes).toBe(2);
  expect(claim.consumedPromptIds).toEqual(["p1"]);
  expect(deps.postLinearAgentActivity).toHaveBeenCalledExactlyOnceWith({
    installationName: "linear-acme",
    sessionId: "session-1",
    content: { type: "thought", body: "Got it — continuing." },
  });
  expect(hook.disposed).toEqual([LISTENING]);
});

test("unread messages sent before the question answer it at once, joined by author", async () => {
  claim.consumedPromptIds.push("p1");
  reads = [
    [
      prompt("p1", "old"),
      prompt("p2", "use the left one"),
      prompt("p3", "", { signal: "stop" }),
      prompt("p4", "agreed", { author: { id: "u2", name: "Bo" } }),
    ],
  ];
  const reply = await haltForHuman(claim, HALT, deps);

  expect(reply).toEqual({
    body: "Ada: use the left one\n\nBo: agreed",
    author: { id: "u2", name: "Bo" },
    createdAt: "2026-10-07T10:04:00Z",
  });
  expect(hook.wakes).toBe(0);
  expect(claim.consumedPromptIds).toEqual(["p1", "p2", "p4"]);
});

test("the listening hook is disposed when asking fails", async () => {
  deps.postTicketHumanInputRequest.mockRejectedValueOnce(new Error("Linear API 503"));
  await expect(haltForHuman(claim, HALT, deps)).rejects.toThrow("Linear API 503");
  expect(hook.disposed).toEqual([LISTENING]);
});
