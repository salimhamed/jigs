import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SlackAuthor, SlackMessageSnapshot, SlackPost } from "./snapshot.ts";
import { waitForSlackReply } from "./wait-for-reply.ts";

const { createHook, hook, sleep, timer } = vi.hoisted(() => ({
  createHook: vi.fn(),
  sleep: vi.fn(),
  timer: { fire: null as (() => void) | null },
  hook: {
    awaited: 0,
    disposed: 0,
    wake: null as (() => void) | null,
  },
}));
vi.mock("workflow", () => ({ createHook, sleep }));
beforeEach(() => {
  Object.assign(hook, { awaited: 0, disposed: 0, wake: null });
  timer.fire = null;
  sleep.mockReset();
  sleep.mockImplementation(
    () =>
      new Promise<void>((fire) => {
        timer.fire = () => fire();
      }),
  );
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
const lastRead = "1790723480.100200";
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
const future = "2999-01-01T00:00:00Z";
const past = "2000-01-01T00:00:00Z";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("returns the human replies after the last read, without parking", async () => {
  const answer = post("1790723501.000300", salim, "the payments team");
  const fetchSlackMessage = vi.fn(async () => thread(post(lastRead, ownBot), answer));
  expect(await waitForSlackReply({ channel, threadTs, lastRead }, { fetchSlackMessage })).toEqual([
    answer,
  ]);
  expect(createHook).toHaveBeenCalledWith({ token: `slack:thread:${channel}:${threadTs}` });
  expect(fetchSlackMessage).toHaveBeenCalledExactlyOnceWith({ channel, ts: threadTs });
  expect(hook.awaited).toBe(0);
  expect(hook.disposed).toBe(1);
});

test("a bot's reply and a reply before the last read never count, however often it wakes", async () => {
  const earlier = post("1790723479.000001", salim, "said before the question");
  const answer = post("1790723600.000001", salim, "now");
  const reads = [
    thread(earlier, post(lastRead, ownBot)),
    thread(earlier, post(lastRead, ownBot), post("1790723590.000001", ownBot, "jigs again")),
    thread(earlier, post(lastRead, ownBot), answer),
  ];
  const fetchSlackMessage = vi.fn(async () => reads.shift() ?? thread());
  const waiting = waitForSlackReply({ channel, threadTs, lastRead }, { fetchSlackMessage });
  await flush();
  expect(hook.awaited).toBe(1);
  hook.wake?.();
  await flush();
  expect(hook.awaited).toBe(2);
  hook.wake?.();
  expect(await waiting).toEqual([answer]);
  expect(fetchSlackMessage).toHaveBeenCalledTimes(3);
  expect(hook.disposed).toBe(1);
});

test("replies within the same second are ordered by their microseconds", async () => {
  const answer = post("1790723480.100201", salim);
  const fetchSlackMessage = vi.fn(async () =>
    thread(post("1790723480.100199", salim), post(lastRead, ownBot), answer),
  );
  expect(await waitForSlackReply({ channel, threadTs, lastRead }, { fetchSlackMessage })).toEqual([
    answer,
  ]);
});

test("a reply posted between the last read and the workflow's question is returned", async () => {
  const between = post("1790723490.000001", salim, "also, it's urgent");
  const fetchSlackMessage = vi.fn(async () =>
    thread(post(lastRead, salim), between, post("1790723495.000001", ownBot, "which service?")),
  );
  expect(await waitForSlackReply({ channel, threadTs, lastRead }, { fetchSlackMessage })).toEqual([
    between,
  ]);
});

test("every human reply after the last read comes back, oldest first, without bots", async () => {
  const first = post("1790723501.000001", salim, "the payments team");
  const second = post("1790723502.000001", salim, "ask Dana");
  const fetchSlackMessage = vi.fn(async () =>
    thread(post(lastRead, salim), first, post("1790723501.500000", ownBot, "thanks"), second),
  );
  expect(await waitForSlackReply({ channel, threadTs, lastRead }, { fetchSlackMessage })).toEqual([
    first,
    second,
  ]);
  expect(hook.awaited).toBe(0);
});

const gone = async (): Promise<SlackMessageSnapshot> => ({ gone: true, channel, ts: threadTs });

test("a message already deleted returns gone, without parking", async () => {
  const fetchSlackMessage = vi.fn(gone);
  expect(await waitForSlackReply({ channel, threadTs, lastRead }, { fetchSlackMessage })).toBe(
    "gone",
  );
  expect(hook.awaited).toBe(0);
  expect(hook.disposed).toBe(1);
});

test("a message deleted while the run waits returns gone", async () => {
  const reads = [thread(post(lastRead, ownBot))];
  const fetchSlackMessage = vi.fn(async () => reads.shift() ?? gone());
  const waiting = waitForSlackReply(
    { channel, threadTs, lastRead, until: future },
    { fetchSlackMessage },
  );
  await flush();
  expect(hook.awaited).toBe(1);
  hook.wake?.();
  expect(await waiting).toBe("gone");
  expect(fetchSlackMessage).toHaveBeenCalledTimes(2);
  expect(hook.disposed).toBe(1);
});

afterEach(() => {
  vi.useRealTimers();
});

test("a reply before the deadline is returned, with one timer for the whole wait", async () => {
  const answer = post("1790723600.000001", salim, "now");
  const reads = [thread(post(lastRead, ownBot)), thread(post(lastRead, ownBot)), thread(answer)];
  const fetchSlackMessage = vi.fn(async () => reads.shift() ?? thread());
  const waiting = waitForSlackReply(
    { channel, threadTs, lastRead, until: future },
    { fetchSlackMessage },
  );
  await flush();
  hook.wake?.();
  await flush();
  expect(hook.awaited).toBe(2);
  hook.wake?.();
  expect(await waiting).toEqual([answer]);
  expect(sleep).toHaveBeenCalledExactlyOnceWith(new Date(future));
  expect(hook.disposed).toBe(1);
});

test("a deadline already passed times out after one read, without parking", async () => {
  const fetchSlackMessage = vi.fn(async () => thread(post(lastRead, ownBot)));
  expect(
    await waitForSlackReply({ channel, threadTs, lastRead, until: past }, { fetchSlackMessage }),
  ).toBe("timed-out");
  expect(fetchSlackMessage).toHaveBeenCalledOnce();
  expect(sleep).not.toHaveBeenCalled();
  expect(hook.awaited).toBe(0);
  expect(hook.disposed).toBe(1);
});

test("a reply already in the thread wins over a deadline that has passed", async () => {
  const answer = post("1790723501.000300", salim);
  const fetchSlackMessage = vi.fn(async () => thread(post(lastRead, ownBot), answer));
  expect(
    await waitForSlackReply({ channel, threadTs, lastRead, until: past }, { fetchSlackMessage }),
  ).toEqual([answer]);
});

test("when the deadline wins, the wait times out and releases the thread's hook", async () => {
  const fetchSlackMessage = vi.fn(async () => thread(post(lastRead, ownBot)));
  const waiting = waitForSlackReply(
    { channel, threadTs, lastRead, until: future },
    { fetchSlackMessage },
  );
  await flush();
  expect(hook.awaited).toBe(1);
  expect(hook.disposed).toBe(0);
  timer.fire?.();
  expect(await waiting).toBe("timed-out");
  expect(fetchSlackMessage).toHaveBeenCalledOnce();
  expect(hook.disposed).toBe(1);
});

test("a wake that reads the thread after the deadline times out without the timer", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
  const fetchSlackMessage = vi.fn(async () => thread(post(lastRead, ownBot)));
  const waiting = waitForSlackReply(
    { channel, threadTs, lastRead, until: "2026-10-02T12:00:05Z" },
    { fetchSlackMessage },
  );
  await flush();
  expect(hook.awaited).toBe(1);
  vi.setSystemTime(new Date("2026-10-02T12:00:06Z"));
  hook.wake?.();
  expect(await waiting).toBe("timed-out");
  expect(fetchSlackMessage).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledOnce();
  expect(hook.disposed).toBe(1);
});

test.each(["tomorrow", "Oct 3 2026", "2026"])(
  "an until of %j fails before anything is awaited",
  async (until) => {
    const fetchSlackMessage = vi.fn();
    await expect(
      waitForSlackReply({ channel, threadTs, lastRead, until }, { fetchSlackMessage }),
    ).rejects.toThrow(`until must be an ISO 8601 timestamp, got ${JSON.stringify(until)}`);
    expect(createHook).not.toHaveBeenCalled();
  },
);
