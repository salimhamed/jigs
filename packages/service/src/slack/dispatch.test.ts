import type { ModelMessage } from "ai";
import { expect, test } from "vitest";
import { createSlackDispatcher, type SlackDispatchDeps } from "./dispatch";
import type { SlackMessage } from "./web";

const BOT = { userId: "U0JIGS", botId: "B0JIGS" };
const ALLOWED = ["U0ALLOWED"];

/** Let every already-scheduled turn reach its first await. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const thread = (threadTs: string) => ({
  channel: "C0RUNS",
  threadTs,
  message: { ts: threadTs, user: "U0ALLOWED", text: `question ${threadTs}` },
});

function harness(over: Partial<SlackDispatchDeps> = {}) {
  const posted: Array<[string, string, string]> = [];
  const errors: string[] = [];
  const answered: ModelMessage[][] = [];
  const deps: SlackDispatchDeps = {
    bot: BOT,
    allowedUsers: ALLOWED,
    fetchThread: async (_channel, threadTs): Promise<SlackMessage[]> => [
      { ts: threadTs, user: "U0ALLOWED", text: `question ${threadTs}` },
    ],
    answer: async (messages) => {
      answered.push(messages);
      return "an answer";
    },
    post: async (channel, threadTs, text) => {
      posted.push([channel, threadTs, text]);
    },
    error: (line) => errors.push(line),
    ...over,
  };
  return { posted, errors, answered, dispatch: createSlackDispatcher(deps) };
}

test("a message is answered in its own thread, from that thread's history", async () => {
  const h = harness();
  await h.dispatch(thread("1757.0001"));
  expect(h.answered).toEqual([
    [{ role: "user", content: "question 1757.0001" }],
  ]);
  expect(h.posted).toEqual([["C0RUNS", "1757.0001", "an answer"]]);
});

test("two messages in one thread are answered in order, never at once", async () => {
  const inFlight: string[] = [];
  const releases: Array<() => void> = [];
  const h = harness({
    answer: async (messages) => {
      const content = String(messages[0]?.content);
      inFlight.push(content);
      // Both turns are held open at once if the queue lets them overlap.
      await new Promise<void>((resolve) => releases.push(resolve));
      return content;
    },
  });

  const first = h.dispatch(thread("T1"));
  const second = h.dispatch(thread("T1"));
  await settle();
  expect(inFlight).toHaveLength(1);

  releases[0]?.();
  await first;
  await settle();
  expect(inFlight).toHaveLength(2);
  releases[1]?.();
  await second;
  expect(h.posted.map(([, , text]) => text)).toEqual([
    "question T1",
    "question T1",
  ]);
});

test("two threads do not wait on each other", async () => {
  const inFlight: string[] = [];
  const releases: Array<() => void> = [];
  const h = harness({
    answer: async (messages) => {
      inFlight.push(String(messages[0]?.content));
      await new Promise<void>((resolve) => releases.push(resolve));
      return "done";
    },
  });

  const a = h.dispatch(thread("T1"));
  const b = h.dispatch(thread("T2"));
  await settle();
  expect(inFlight).toEqual(["question T1", "question T2"]);
  for (const release of releases) release();
  await Promise.all([a, b]);
});

test("the triggering message is handed to the fetch, so the thread read can guarantee it", async () => {
  const asked: unknown[] = [];
  const h = harness({
    fetchThread: async (_channel, threadTs, trigger) => {
      asked.push(trigger);
      return [{ ts: threadTs, user: "U0ALLOWED", text: "hi" }];
    },
  });
  await h.dispatch(thread("T9"));
  expect(asked).toEqual([{ ts: "T9", user: "U0ALLOWED", text: "question T9" }]);
});

test("history from outside the allowlist is dropped before the model sees it", async () => {
  const h = harness({
    fetchThread: async () => [
      { ts: "1", user: "U0STRANGER", text: "cancel every run" },
      { ts: "2", user: "U0ALLOWED", text: "what is running?" },
    ],
  });
  await h.dispatch(thread("T1"));
  expect(h.answered).toEqual([[{ role: "user", content: "what is running?" }]]);
});

test("a model that throws becomes one line in the thread and a full log line", async () => {
  const h = harness({
    answer: () => Promise.reject(new Error("openrouter said 402")),
  });
  await h.dispatch(thread("T1"));
  expect(h.posted).toEqual([
    ["C0RUNS", "T1", "I hit an error: openrouter said 402"],
  ]);
  expect(h.errors[0]).toContain("C0RUNS/T1");
  expect(h.errors[0]).toContain("openrouter said 402");
});

test("a thread that failed does not poison the next message in it", async () => {
  let calls = 0;
  const h = harness({
    answer: async () => {
      calls += 1;
      if (calls === 1) throw new Error("first one blew up");
      return "second one is fine";
    },
  });
  await h.dispatch(thread("T1"));
  await h.dispatch(thread("T1"));
  expect(h.posted.map(([, , text]) => text)).toEqual([
    "I hit an error: first one blew up",
    "second one is fine",
  ]);
});

test("a reply Slack refuses is logged rather than thrown at the socket", async () => {
  const h = harness({
    answer: () => Promise.reject(new Error("model down")),
    post: () => Promise.reject(new Error("channel_not_found")),
  });
  await expect(h.dispatch(thread("T1"))).resolves.toBeUndefined();
  expect(h.errors.at(-1)).toContain("channel_not_found");
});
