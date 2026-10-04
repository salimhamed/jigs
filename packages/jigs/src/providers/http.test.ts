import { expect, test, vi } from "vitest";
import { type ProviderAuth, rateLimitWaits, reauthorize, retryAfterSeconds } from "./http.ts";
import { fakeSleep } from "./test-support.ts";

const watching = (signal: AbortSignal) => {
  const dispose = vi.fn();
  return { watch: async () => ({ signal, dispose }), dispose };
};

test("a rate limit is waited out three times, then given up on", async () => {
  const { sleep, sleeps } = fakeSleep();
  const rateLimit = rateLimitWaits("slack", null, sleep);
  const results = [];
  for (let attempt = 0; attempt < 4; attempt += 1) results.push(await rateLimit.wait(2));
  expect(results).toEqual([true, true, true, false]);
  expect(sleeps).toEqual([2000, 2000, 2000]);
});

test("a wait over a minute is not waited", async () => {
  const { sleep, sleeps } = fakeSleep();
  const rateLimit = rateLimitWaits("pagerduty", null, sleep);
  expect(await rateLimit.wait(61)).toBe(false);
  expect(await rateLimit.wait(60)).toBe(true);
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
  const wait = rateLimitWaits("linear", watch).wait(30);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(cancelled);
  await expect(wait).rejects.toBe(cancelled);
  expect(dispose).toHaveBeenCalledOnce();
});

test("an already-aborted watch skips the wait", async () => {
  const { sleep, sleeps } = fakeSleep();
  const { watch } = watching(AbortSignal.abort(new Error("gone")));
  await expect(rateLimitWaits("slack", watch, sleep).wait(1)).rejects.toThrow("gone");
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
