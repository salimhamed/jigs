import { expect, test } from "vitest";
import { ProviderApiError, type ProviderAuth, providerRequest } from "./http.ts";
import { fakeFetch, fakeSleep, jsonResponse } from "./test-support.ts";

function rotatingAuth(): ProviderAuth & { invalidated: string[] } {
  let generation = 1;
  const invalidated: string[] = [];
  return {
    invalidated,
    bearer: async () => `token-${generation}`,
    invalidate: (stale) => {
      invalidated.push(stale);
      generation += 1;
    },
  };
}

test("a rejection the provider signals in a 200 body re-mints once", async () => {
  const replies = [
    jsonResponse({ errors: [{ extensions: { code: "AUTHENTICATION_ERROR" } }] }),
    jsonResponse({ data: { viewer: { id: "u1" } } }),
  ];
  const { fetch, calls } = fakeFetch(() => replies.shift() as Response);
  const auth = rotatingAuth();
  const reply = await providerRequest<{ data: unknown }>({
    provider: "linear",
    auth,
    url: "https://api.test/graphql",
    method: "POST",
    json: { query: "{ viewer { id } }" },
    isAuthFailure: (_res, text) => text.includes("AUTHENTICATION_ERROR"),
    fetch,
  });
  expect(reply).toEqual({ data: { viewer: { id: "u1" } } });
  expect(auth.invalidated).toEqual(["token-1"]);
  expect(calls.map((call) => call.headers.authorization)).toEqual([
    "Bearer token-1",
    "Bearer token-2",
  ]);
  expect(calls[0]?.headers["content-type"]).toBe("application/json");
});

test("a credential that cannot be invalidated is not retried, and the header is the provider's", async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse({ message: "Bad credentials" }, 401));
  const err = await providerRequest({
    provider: "github",
    auth: { bearer: async () => "lin_api_key" },
    url: "https://api.test/user?x=1",
    authorization: (key) => key,
    fetch,
  }).catch((caught: unknown) => caught);
  expect(err).toBeInstanceOf(ProviderApiError);
  expect(err).toMatchObject({
    provider: "github",
    status: 401,
    body: '{"message":"Bad credentials"}',
  });
  expect((err as Error).message).toBe('GitHub API 401 on GET /user: {"message":"Bad credentials"}');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.headers.authorization).toBe("lin_api_key");
});

test("a 429 waits out retry-after, and the answer it gives up on is the decoder's", async () => {
  const { fetch, calls } = fakeFetch(() =>
    jsonResponse({ ok: false, error: "ratelimited" }, 429, { "retry-after": "2" }),
  );
  const { sleep, sleeps } = fakeSleep();
  const err = await providerRequest({
    provider: "slack",
    auth: { bearer: async () => "xoxb" },
    url: "https://slack.test/api/auth.test",
    method: "POST",
    request: "auth.test",
    decode: (_res, text, fail) => {
      const body = JSON.parse(text) as { ok: boolean; error?: string };
      if (!body.ok) throw fail({ code: body.error, message: `Slack auth.test: ${body.error}` });
      return body;
    },
    fetch,
    sleep,
  }).catch((caught: unknown) => caught);
  expect(sleeps).toEqual([2000, 2000, 2000]);
  expect(calls).toHaveLength(4);
  expect(err).toMatchObject({ provider: "slack", status: 429, code: "ratelimited" });
  expect((err as Error).message).toBe("Slack auth.test: ratelimited");
});

test("a 429 asking for more than a minute fails at once, naming the wait", async () => {
  const { fetch } = fakeFetch(() => jsonResponse({}, 429, { "retry-after": "61" }));
  const { sleep, sleeps } = fakeSleep();
  await expect(
    providerRequest({
      provider: "pagerduty",
      auth: { bearer: async () => "t" },
      url: "https://pd.test/x",
      fetch,
      sleep,
    }),
  ).rejects.toThrow("PagerDuty API 429 on GET /x: rate limited for 61s");
  expect(sleeps).toEqual([]);
});

test("a provider can name another answer a rate limit, and it is waited out like a 429", async () => {
  const replies = [jsonResponse({}, 403, { "retry-after": "3" }), jsonResponse({ ok: true })];
  const { fetch, calls } = fakeFetch(() => replies.shift() as Response);
  const { sleep, sleeps } = fakeSleep();
  const reply = await providerRequest({
    provider: "github",
    auth: { bearer: async () => "t" },
    url: "https://gh.test/x",
    isRateLimited: (res) => res.status === 403 && res.headers.has("retry-after"),
    fetch,
    sleep,
  });
  expect(reply).toEqual({ ok: true });
  expect(sleeps).toEqual([3000]);
  expect(calls).toHaveLength(2);
});
