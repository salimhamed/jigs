import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { wakeSlackThread } from "./slack-thread-wake.ts";
import { clearWakes, lastWake } from "./wake.ts";

vi.mock("workflow/api", () => ({ resumeHook: vi.fn() }));
const resumeHookMock = vi.mocked(resumeHook);

const TOKEN = "slack:thread:C0C5EUZ7P9Q:1790723478.961719";

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
  clearWakes();
  resumeHookMock.mockReset().mockResolvedValue({ runId: "wrun_A" } as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

test("a reply whose thread_ts matches a waiting run wakes it and notes the wake", async () => {
  expect(await wakeSlackThread(reply)).toBe(true);
  expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith(TOKEN, undefined);
  expect(lastWake(TOKEN, "wrun_A")?.kind).toBe("slack reply");
});

test("a reply in a thread no run waits on wakes nothing", async () => {
  resumeHookMock.mockRejectedValue(new HookNotFoundError(TOKEN));
  expect(await wakeSlackThread(reply)).toBe(false);
});

test("a top-level message or a bot's reply resumes nothing", async () => {
  expect(await wakeSlackThread({ ...reply, thread_ts: undefined })).toBe(false);
  expect(await wakeSlackThread({ ...reply, bot_id: "B0C5JPZUW1J" })).toBe(false);
  expect(resumeHookMock).not.toHaveBeenCalled();
});

test("any other resume failure is logged, not thrown", async () => {
  resumeHookMock.mockRejectedValue(new Error("world down"));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await wakeSlackThread(reply)).toBe(false);
  expect(String(errors.mock.calls[0]?.[0])).toContain("world down");
});
