import { afterEach, expect, test, vi } from "vitest";
import { testFactoryContext } from "../test-fixtures.ts";
import { createHubTokens } from "./credentials.ts";
import { createLinearClient } from "./linear.ts";
import { createLinearAuth, LINEAR_API_URL, linearAuthFor } from "./linear-auth.ts";
import { answerHubTokens } from "./test-fixtures.ts";
import { fakeFetch, fakeSleep, jsonResponse } from "./test-support.ts";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const APP = { name: "jigs", userId: "app-user" };

afterEach(() => {
  vi.restoreAllMocks();
});

// The hub answering each token request with the next token, each living a day.
function hubIssuing(...tokens: string[]) {
  return vi.fn(async () => {
    const token = tokens.shift();
    if (token === undefined) throw new Error("the hub is down");
    return { token, expiresAt: new Date(NOW + 86_400_000).toISOString(), app: APP };
  });
}

test("a token is reused until five minutes are left, then asked for again", async () => {
  const issue = hubIssuing("first", "second");
  let now = NOW;
  const auth = createLinearAuth(createHubTokens(issue, () => now));
  expect(await auth.bearer()).toBe("first");
  now = NOW + 86_400_000 - 6 * 60_000;
  expect(await auth.bearer()).toBe("first");
  now = NOW + 86_400_000 - 4 * 60_000;
  expect(await auth.bearer()).toBe("second");
  expect(issue).toHaveBeenCalledTimes(2);
});

test("a caller can ask for a token with more time left than jigs' own margin", async () => {
  const issue = hubIssuing("first", "second");
  let now = NOW;
  const auth = createLinearAuth(createHubTokens(issue, () => now));
  await auth.bearer();
  now = NOW + 86_400_000 - 3 * 60 * 60_000;
  expect(await auth.bearer()).toBe("first");
  expect(await auth.bearer(4 * 60 * 60_000)).toBe("second");
});

test("the app's own user is the one the hub names", async () => {
  const issue = hubIssuing("t");
  const auth = createLinearAuth(createHubTokens(issue, () => NOW));
  expect(await auth.user()).toEqual({ id: "app-user", name: "jigs" });
  await auth.bearer();
  expect(issue).toHaveBeenCalledTimes(1);
});

test("callers that arrive together share one request", async () => {
  const issue = hubIssuing("shared");
  const auth = createLinearAuth(createHubTokens(issue, () => NOW));
  const tokens = await Promise.all(Array.from({ length: 4 }, () => auth.bearer()));
  expect(tokens).toEqual(Array(4).fill("shared"));
  expect(issue).toHaveBeenCalledTimes(1);
});

test("each installation has its own token, asked of the factory's hub once per factory", async () => {
  const spy = answerHubTokens("linear", async (installationName) => ({
    token: `token-${installationName}`,
    expiresAt: "2999-01-01T00:00:00Z",
    app: APP,
  }));
  const ctx = testFactoryContext();
  expect(await linearAuthFor("acme", ctx).bearer()).toBe("token-acme");
  expect(await linearAuthFor("acme", ctx).bearer()).toBe("token-acme");
  expect(await linearAuthFor("other", ctx).bearer()).toBe("token-other");
  expect(spy.mock.calls).toEqual([
    ["acme", ctx],
    ["other", ctx],
  ]);
});

const USERS = { data: { users: { nodes: [{ id: "u1", name: "Ada" }] } } };
const AUTHENTICATION_ERROR = {
  errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }],
};

function graphqlServer(replies: Array<number | "auth-error">) {
  const server = fakeFetch(() => {
    const reply = replies.shift() ?? 200;
    if (reply === "auth-error") return jsonResponse(AUTHENTICATION_ERROR);
    return reply === 200
      ? jsonResponse(USERS)
      : new Response("authentication required", { status: reply });
  });
  const issue = hubIssuing("token-1", "token-2", "token-3");
  const client = createLinearClient({
    installationName: "acme",
    auth: createLinearAuth(createHubTokens(issue, () => NOW)),
    fetch: server.fetch,
  });
  return { calls: server.calls, client, issue };
}

test("a token Linear rejects is asked of the hub again and the call retried once", async () => {
  const { calls, client } = graphqlServer([401]);
  expect(await client.findUserByEmail("ada@example.com")).toEqual({ id: "u1", name: "Ada" });
  expect(calls.map((call) => [call.url.toString(), call.headers.authorization])).toEqual([
    [LINEAR_API_URL, "Bearer token-1"],
    [LINEAR_API_URL, "Bearer token-2"],
  ]);
});

test("an AUTHENTICATION_ERROR under a 200 asks the hub again once", async () => {
  const { calls, client } = graphqlServer(["auth-error"]);
  expect(await client.findUserByEmail("ada@example.com")).toEqual({ id: "u1", name: "Ada" });
  expect(calls.map((call) => call.headers.authorization)).toEqual([
    "Bearer token-1",
    "Bearer token-2",
  ]);
});

test("a second rejection says to connect the workspace again in the hub", async () => {
  for (const reply of [401, "auth-error"] as const) {
    const { calls, client, issue } = graphqlServer([reply, reply]);
    await expect(client.findUserByEmail("ada@example.com")).rejects.toThrow(
      "Linear refused the app's token again after the hub issued a fresh one; connect the Linear workspace again in the hub",
    );
    expect(calls).toHaveLength(2);
    expect(issue).toHaveBeenCalledTimes(2);
  }
});

test("a rate-limited call waits as Linear asks, then retries", async () => {
  const server = fakeFetch(() =>
    server.calls.length === 1
      ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
      : jsonResponse(USERS),
  );
  const { sleep, sleeps } = fakeSleep();
  const client = createLinearClient({
    installationName: "acme",
    auth: createLinearAuth(createHubTokens(hubIssuing("t"), () => NOW)),
    fetch: server.fetch,
    sleep,
  });
  expect(await client.findUserByEmail("ada@example.com")).toEqual({ id: "u1", name: "Ada" });
  expect(sleeps).toEqual([2000]);
  expect(server.calls).toHaveLength(2);
});
