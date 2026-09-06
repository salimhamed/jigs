import { expect, test } from "vitest";
import {
  pageThread,
  type RepliesPage,
  type SlackMessage,
  threadTail,
} from "./web";

const message = (ts: string): SlackMessage => ({
  ts,
  user: "U0ALLOWED",
  text: `turn ${ts}`,
});

const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => message(String(from + i)));

test("paging follows next_cursor until Slack stops offering one", async () => {
  const pages: RepliesPage[] = [
    { messages: range(0, 3), cursor: "c1" },
    { messages: range(3, 6), cursor: "c2" },
    { messages: range(6, 8), cursor: null },
  ];
  const asked: Array<string | null> = [];
  const all = await pageThread(async (cursor) => {
    asked.push(cursor);
    return pages[asked.length - 1] as RepliesPage;
  });
  expect(asked).toEqual([null, "c1", "c2"]);
  expect(all.map((m) => m.ts)).toEqual([
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
  ]);
});

test("paging stops rather than looping when Slack keeps handing back a cursor", async () => {
  let calls = 0;
  const all = await pageThread(async () => {
    calls += 1;
    return { messages: [message(String(calls))], cursor: "always-more" };
  });
  expect(calls).toBe(20);
  expect(all).toHaveLength(20);
});

test("a long thread keeps the newest turns, not the oldest", () => {
  // conversations.replies pages from the parent forward, so the first page is
  // the wrong end of a 200-message thread.
  const tail = threadTail(range(0, 200), message("199"));
  expect(tail).toHaveLength(60);
  expect(tail[0]?.ts).toBe("140");
  expect(tail.at(-1)?.ts).toBe("199");
});

test("the message being answered is present even when Slack's read of the thread lags it", () => {
  // The event announced a message conversations.replies has not caught up to
  // yet; answering a question the model was never shown is the worst failure
  // this has.
  const trigger = message("201");
  const tail = threadTail(range(0, 200), trigger);
  expect(tail).toHaveLength(60);
  expect(tail.at(-1)).toBe(trigger);
  expect(tail[0]?.ts).toBe("141");
});

test("a thread shorter than the cap comes back whole", () => {
  const messages = range(0, 4);
  expect(threadTail(messages, message("3"))).toEqual(messages);
});
