import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HookNotFoundError } from "workflow/errors";
import { wakeSlackThread } from "./slack-thread-wake.ts";

vi.mock("workflow/api", () => ({ resumeHook: vi.fn() }));

// A Socket Mode `message` event for a reply, as startSlackSocket hands it on.
const reply = {
  type: "message",
  channel: "C0C5EUZ7P9Q",
  channel_type: "channel",
  user: "U01PW925E6N",
  text: "the payments team",
  ts: "1790723501.000300",
  thread_ts: "1790723478.961719",
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

test("a reply whose thread_ts matches a waiting run resumes its hook", async () => {
  const resume = vi.fn(async () => undefined);
  expect(await wakeSlackThread(reply, resume)).toBe(true);
  expect(resume).toHaveBeenCalledExactlyOnceWith("slack:thread:C0C5EUZ7P9Q:1790723478.961719");
});

test("a reply in a thread no run waits on wakes nothing", async () => {
  const resume = vi.fn(async () => {
    throw new HookNotFoundError("slack:thread:C0C5EUZ7P9Q:1790723478.961719");
  });
  expect(await wakeSlackThread(reply, resume)).toBe(false);
});

test("a top-level message or a bot's reply resumes nothing", async () => {
  const resume = vi.fn(async () => undefined);
  expect(await wakeSlackThread({ ...reply, thread_ts: undefined }, resume)).toBe(false);
  expect(await wakeSlackThread({ ...reply, bot_id: "B0C5JPZUW1J" }, resume)).toBe(false);
  expect(resume).not.toHaveBeenCalled();
});

test("any other resume failure reaches the socket's handler", async () => {
  const resume = vi.fn(async () => {
    throw new Error("world down");
  });
  await expect(wakeSlackThread(reply, resume)).rejects.toThrow("world down");
});
