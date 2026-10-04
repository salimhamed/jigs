import { expect, test, vi } from "vitest";
import { type ProviderAuth, rateLimitWait, reauthorize, retryAfterSeconds } from "./http.ts";
import { fakeSleep } from "./test-support.ts";

const watching = (signal: AbortSignal) => {
  const dispose = vi.fn();
  return { watch: async () => ({ signal, dispose }), dispose };
};

test("a rate limit is waited out three times, then given up on", async () => {
  const { sleep, sleeps } = fakeSleep();
  const results = [];
  for (let waited = 0; waited < 4; waited += 1) {
    results.push(await rateLimitWait("slack", 2, waited, null, sleep));
  }
  expect(results).toEqual([true, true, true, false]);
  expect(sleeps).toEqual([2000, 2000, 2000]);
});

test("a wait over a minute is not waited", async () => {
  const { sleep, sleeps } = fakeSleep();
  expect(await rateLimitWait("pagerduty", 61, 0, null, sleep)).toBe(false);
  expect(await rateLimitWait("pagerduty", 60, 0, null, sleep)).toBe(true);
  expect(sleeps).toEqual([60_000]);
});

test("retry-after names the wait, else the fallback", () => {
  const limited = (headers: Record<string, string>) => new Response("", { status: 429, headers });
  expect(retryAfterSeconds(limited({ "retry-after": "7" }))).toBe(7);
  expect(retryAfterSeconds(limited({ "retry-after": "soon" }))).toBe(1);
  expect(retryAfterSeconds(limited({}), 5)).toBe(5);
});

test("an abort ends a rate-limit wait with the signal's reason", async () => {
  const controller = new AbortController();
  const { watch, dispose } = watching(controller.signal);
  const cancelled = new Error("run cancelled");
  const wait = rateLimitWait("linear", 30, 0, watch);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(cancelled);
  await expect(wait).rejects.toBe(cancelled);
  expect(dispose).toHaveBeenCalledOnce();
});

test("an already-aborted watch skips the wait", async () => {
  const { sleep, sleeps } = fakeSleep();
  const { watch } = watching(AbortSignal.abort(new Error("gone")));
  await expect(rateLimitWait("slack", 1, 0, watch, sleep)).rejects.toThrow("gone");
  expect(sleeps).toEqual([]);
});

test("a rejected credential is forgotten only when it can be minted again", () => {
  const invalidated: string[] = [];
  const minted: ProviderAuth = {
    bearer: async () => "token",
    invalidate: (stale) => invalidated.push(stale),
  };
  expect(reauthorize(minted, "token-1")).toBe(true);
  expect(invalidated).toEqual(["token-1"]);
  expect(reauthorize({ bearer: async () => "lin_api_key" }, "lin_api_key")).toBe(false);
});
