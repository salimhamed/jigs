import { expect, test } from "vitest";
import { createHubTokens } from "./credentials.ts";

test("the hub's token is reused until shortly before it expires", async () => {
  let now = Date.parse("2026-10-05T00:00:00Z");
  let issued = 0;
  const tokens = createHubTokens(
    async () => ({ token: `tok-${++issued}`, expiresAt: "2026-10-05T01:00:00Z" }),
    () => now,
  );
  expect(await tokens.bearer()).toBe("tok-1");
  expect(await tokens.bearer()).toBe("tok-1");
  now = Date.parse("2026-10-05T00:56:00Z");
  expect(await tokens.bearer()).toBe("tok-2");
});

test("concurrent callers share one request to the hub, and a stale token is asked for again", async () => {
  let issued = 0;
  const tokens = createHubTokens(async () => ({
    token: `tok-${++issued}`,
    expiresAt: "2999-01-01T00:00:00Z",
  }));
  expect(await Promise.all([tokens.bearer(), tokens.bearer()])).toEqual(["tok-1", "tok-1"]);
  tokens.invalidate("tok-0");
  expect(await tokens.bearer()).toBe("tok-1");
  tokens.invalidate("tok-1");
  expect(await tokens.bearer()).toBe("tok-2");
});

test("an agent asking for a long-lived token gets a fresh one", async () => {
  let issued = 0;
  const now = Date.parse("2026-10-05T00:00:00Z");
  const tokens = createHubTokens(
    async () => ({ token: `tok-${++issued}`, expiresAt: "2026-10-05T02:00:00Z" }),
    () => now,
  );
  expect(await tokens.bearer()).toBe("tok-1");
  expect(await tokens.bearer(5 * 3600_000)).toBe("tok-2");
});

test("a token without an expiry is kept until it is refused", async () => {
  let now = 0;
  let issued = 0;
  const tokens = createHubTokens(
    async () => ({ token: `tok-${++issued}` }),
    () => now,
  );
  expect(await tokens.bearer(5 * 3600_000)).toBe("tok-1");
  now = 365 * 24 * 3600_000;
  expect(await tokens.bearer()).toBe("tok-1");
  tokens.invalidate("tok-1");
  expect(await tokens.bearer()).toBe("tok-2");
});
