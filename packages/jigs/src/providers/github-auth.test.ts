import { afterEach, expect, test, vi } from "vitest";
import { testFactoryContext } from "../test-fixtures.ts";
import { createHubTokens } from "./credentials.ts";
import { createGithubAuth, githubAuthFor } from "./github-auth.ts";
import { answerHubTokens, useGithubClient } from "./test-fixtures.ts";
import { fakeFetch, jsonResponse } from "./test-support.ts";

const NOW = Date.parse("2026-09-15T12:00:00Z");
const APP = { slug: "jigs-dev", botUserId: 77 };

afterEach(() => {
  vi.restoreAllMocks();
});

// The hub answering each token request with the next token, each living an hour.
function hubIssuing(...tokens: string[]) {
  return vi.fn(async () => {
    const token = tokens.shift();
    if (token === undefined) throw new Error("the hub is down");
    return {
      token,
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
      account: "acme",
      app: APP,
    };
  });
}

test("a token is reused until five minutes are left, then asked for again", async () => {
  const issue = hubIssuing("first", "second");
  let now = NOW;
  const auth = createGithubAuth(createHubTokens(issue, () => now));
  expect(await auth.bearer()).toBe("first");
  now = NOW + 54 * 60_000;
  expect(await auth.bearer()).toBe("first");
  now = NOW + 56 * 60_000;
  expect(await auth.bearer()).toBe("second");
  expect(issue).toHaveBeenCalledTimes(2);
});

test("a caller can ask for a token with more time left than jigs' own margin", async () => {
  const issue = hubIssuing("first", "second");
  let now = NOW;
  const auth = createGithubAuth(createHubTokens(issue, () => now));
  await auth.bearer();
  now = NOW + 10 * 60_000;
  expect(await auth.bearer(55 * 60_000)).toBe("second");
});

test("the bot and account are the ones the hub names, the bot as <slug>[bot] with its user id", async () => {
  const issue = hubIssuing("t");
  const auth = createGithubAuth(createHubTokens(issue, () => NOW));
  expect(await auth.bot()).toEqual({ login: "jigs-dev[bot]", id: 77 });
  expect(await auth.account()).toBe("acme");
  await auth.bearer();
  expect(issue).toHaveBeenCalledTimes(1);
});

test("callers that arrive together share one request rather than each making their own", async () => {
  const issue = hubIssuing("shared");
  const auth = createGithubAuth(createHubTokens(issue, () => NOW));
  const tokens = await Promise.all(Array.from({ length: 6 }, () => auth.bearer()));
  expect(tokens).toEqual(Array(6).fill("shared"));
  expect(issue).toHaveBeenCalledTimes(1);
});

test("a failed request is not cached, so the next caller tries again", async () => {
  const issue = vi
    .fn()
    .mockRejectedValueOnce(new Error("the hub is down"))
    .mockResolvedValueOnce({
      token: "second-time",
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
      account: "acme",
      app: APP,
    });
  const auth = createGithubAuth(createHubTokens(issue, () => NOW));
  await expect(auth.bearer()).rejects.toThrow("the hub is down");
  expect(await auth.bearer()).toBe("second-time");
});

test("a token GitHub rejects is asked for again once, so a revoked token does not wait out its hour", async () => {
  const issue = hubIssuing("revoked", "fresh");
  const replies = [jsonResponse({ message: "Bad credentials" }, 401), jsonResponse({ id: 1 })];
  const { fetch, calls } = fakeFetch(() => replies.shift() as Response);
  useGithubClient({ fetch });
  const auth = createGithubAuth(createHubTokens(issue, () => NOW));
  const { githubSend } = await import("./github-http.ts");
  await expect(githubSend({ auth, apiPath: "/repos/acme/api" })).resolves.toEqual({ id: 1 });
  expect(calls.map((call) => call.headers.authorization)).toEqual([
    "Bearer revoked",
    "Bearer fresh",
  ]);
});

test("each installation has its own token, asked of the factory's hub once per factory", async () => {
  const spy = answerHubTokens("github", async (installationName) => ({
    token: `token-${installationName}`,
    expiresAt: "2999-01-01T00:00:00Z",
    account: installationName,
    app: APP,
  }));
  const ctx = testFactoryContext();
  expect(await githubAuthFor("acme", ctx).bearer()).toBe("token-acme");
  expect(await githubAuthFor("acme", ctx).bearer()).toBe("token-acme");
  expect(await githubAuthFor("other", ctx).bearer()).toBe("token-other");
  expect(spy.mock.calls).toEqual([
    ["acme", ctx],
    ["other", ctx],
  ]);
  // A new context starts with no tokens.
  await githubAuthFor("acme", testFactoryContext()).bearer();
  expect(spy).toHaveBeenCalledTimes(3);
});
