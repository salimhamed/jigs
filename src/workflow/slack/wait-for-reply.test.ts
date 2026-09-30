import { beforeEach, expect, test, vi } from "vitest";
import type { SlackAuthor, SlackMessageSnapshot, SlackPost } from "./snapshot.ts";
import { waitForSlackReply } from "./wait-for-reply.ts";

const { createHook, hook } = vi.hoisted(() => ({
  createHook: vi.fn(),
  hook: {
    awaited: 0,
    disposed: 0,
    wake: null as (() => void) | null,
  },
}));
vi.mock("workflow", () => ({ createHook }));
beforeEach(() => {
  Object.assign(hook, { awaited: 0, disposed: 0, wake: null });
  createHook.mockReset();
  createHook.mockImplementation(() => ({
    // biome-ignore lint/suspicious/noThenProperty: the SDK's Hook is a thenable
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
      hook.awaited += 1;
      return new Promise<unknown>((wake) => {
        hook.wake = () => wake(undefined);
      }).then(resolve, reject);
    },
    dispose: () => {
      hook.disposed += 1;
    },
  }));
});

const channel = "C0C5EUZ7P9Q";
const threadTs = "1790723478.961719";
const question = "1790723480.100200";
const salim: SlackAuthor = {
  id: "U01PW925E6N",
  name: "Salim",
  email: "salim@example.com",
  bot: false,
  isOwnBot: false,
};
const ownBot: SlackAuthor = { id: "U0C59SU5V29", name: "Salim's jigs", bot: true, isOwnBot: true };
const post = (ts: string, author: SlackAuthor, text = "a reply"): SlackPost => ({
  ts,
  text,
  author,
});
const thread = (...replies: SlackPost[]): SlackMessageSnapshot => ({
  gone: false,
  channel,
  permalink: "https://junglescout.slack.com/archives/C0C5EUZ7P9Q/p1790723478961719",
  ...post(threadTs, salim, "which service owns checkout?"),
  replies,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("returns the first human reply after the question, without parking", async () => {
  const answer = post("1790723501.000300", salim, "the payments team");
  const fetchSlackMessage = vi.fn(async () => thread(post(question, ownBot), answer));
  expect(
    await waitForSlackReply({ channel, threadTs, after: question }, { fetchSlackMessage }),
  ).toEqual(answer);
  expect(createHook).toHaveBeenCalledWith({ token: `slack:thread:${channel}:${threadTs}` });
  expect(fetchSlackMessage).toHaveBeenCalledExactlyOnceWith({ channel, ts: threadTs });
  expect(hook.awaited).toBe(0);
  expect(hook.disposed).toBe(1);
});

test("a bot's reply and a reply older than the question never count, however often it wakes", async () => {
  const earlier = post("1790723479.000001", salim, "said before the question");
  const answer = post("1790723600.000001", salim, "now");
  const reads = [
    thread(earlier, post(question, ownBot)),
    thread(earlier, post(question, ownBot), post("1790723590.000001", ownBot, "jigs again")),
    thread(earlier, post(question, ownBot), answer),
  ];
  const fetchSlackMessage = vi.fn(async () => reads.shift() ?? thread());
  const waiting = waitForSlackReply({ channel, threadTs, after: question }, { fetchSlackMessage });
  await flush();
  expect(hook.awaited).toBe(1);
  hook.wake?.();
  await flush();
  expect(hook.awaited).toBe(2);
  hook.wake?.();
  expect(await waiting).toEqual(answer);
  expect(fetchSlackMessage).toHaveBeenCalledTimes(3);
  expect(hook.disposed).toBe(1);
});

test("replies within the same second are ordered by their microseconds", async () => {
  const answer = post("1790723480.100201", salim);
  const fetchSlackMessage = vi.fn(async () =>
    thread(post("1790723480.100199", salim), post(question, ownBot), answer),
  );
  expect(
    await waitForSlackReply({ channel, threadTs, after: question }, { fetchSlackMessage }),
  ).toEqual(answer);
});

test("a message deleted while the run waits fails the wait", async () => {
  const fetchSlackMessage = vi.fn(
    async (): Promise<SlackMessageSnapshot> => ({ gone: true, channel, ts: threadTs }),
  );
  await expect(
    waitForSlackReply({ channel, threadTs, after: question }, { fetchSlackMessage }),
  ).rejects.toThrow(`the Slack message ${channel} ${threadTs} was deleted`);
  expect(hook.disposed).toBe(1);
});
