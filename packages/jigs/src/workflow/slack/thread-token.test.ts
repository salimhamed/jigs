import { expect, test } from "vitest";
import { slackThreadToken, slackThreadTokenFromEvent } from "./thread-token.ts";

const reply = {
  type: "message",
  channel: "C0C5EUZ7P9Q",
  user: "U01PW925E6N",
  ts: "1790723501.000300",
  thread_ts: "1790723478.961719",
};

test("a human's thread reply names the thread's hook", () => {
  expect(slackThreadTokenFromEvent("slack-acme", reply)).toBe(
    slackThreadToken("slack-acme", "C0C5EUZ7P9Q", "1790723478.961719"),
  );
  expect(slackThreadToken("slack-acme", "C0C5EUZ7P9Q", "1790723478.961719")).toBe(
    "slack:thread:slack-acme:C0C5EUZ7P9Q:1790723478.961719",
  );
});

test.each([
  ["a top-level message", { ...reply, thread_ts: undefined }],
  ["a thread's own parent", { ...reply, ts: reply.thread_ts }],
  ["a bot's reply", { ...reply, user: "U0C59SU5V29", bot_id: "B0C5JPZUW1J" }],
  ["no channel", { ...reply, channel: undefined }],
  ["not an object", null],
])("%s names no thread hook", (_, event) => {
  expect(slackThreadTokenFromEvent("slack-acme", event)).toBeNull();
});
