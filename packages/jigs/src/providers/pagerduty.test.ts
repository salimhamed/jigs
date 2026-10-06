import { expect, test } from "vitest";
import { testFactoryContext } from "../test-fixtures.ts";
import { ProviderApiError } from "./http.ts";
import { createPagerDutyClient, PAGERDUTY_API_URL, type PagerDutyTokens } from "./pagerduty.ts";
import { type FetchCall, fakeFetch, fakeSleep, jsonResponse } from "./test-support.ts";

async function rejection<E>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (err) {
    return err as E;
  }
  throw new Error("expected a rejection");
}

const context = testFactoryContext();

// Recorded shapes from api.pagerduty.com, trimmed to the fields jigs reads.
const INCIDENT = {
  id: "Q1ABCDEF",
  type: "incident",
  incident_number: 4242,
  title: "Checkout latency above SLO",
  status: "triggered",
  urgency: "high",
  created_at: "2026-09-29T20:00:00Z",
  html_url: "https://acme.pagerduty.com/incidents/Q1ABCDEF",
  service: { id: "P48FPG2", type: "service_reference", summary: "Checkout" },
};
const NOTE = {
  id: "PNOTE01",
  user: { id: "PUSER01", type: "user_reference", summary: "On Call" },
  content: "jigs is looking",
  created_at: "2026-09-29T20:01:00Z",
};
const USER = { id: "PUSER01", type: "user", name: "On Call", email: "oncall@example.com" };

function fakeTokens() {
  let minted = 0;
  const tokens: PagerDutyTokens & { minted: () => number } = {
    issued: async () => ({
      token: `token-${minted === 0 ? ++minted : minted}`,
      from: "oncall@example.com",
    }),
    invalidate: (stale) => {
      if (stale === `token-${minted}`) minted += 1;
    },
    minted: () => minted,
  };
  return tokens;
}

function server(handle: (call: FetchCall) => Response, ctx = context) {
  const { fetch, calls } = fakeFetch(handle);
  const { sleep, sleeps } = fakeSleep();
  const tokens = fakeTokens();
  const client = createPagerDutyClient({
    installationName: "acme",
    tokens,
    fetch,
    sleep,
    context: ctx,
  });
  return { client, calls, sleeps, tokens };
}

const json = jsonResponse;

test("reads carry the bearer token and the v2 media type, and no From", async () => {
  const { client, calls } = server(() => json({ incident: INCIDENT }));
  expect(await client.getIncident("Q1ABCDEF")).toEqual(INCIDENT);
  expect(calls[0]?.url.toString()).toBe(`${PAGERDUTY_API_URL}/incidents/Q1ABCDEF`);
  expect(calls[0]?.headers).toEqual({
    authorization: "Bearer token-1",
    accept: "application/vnd.pagerduty+json;version=2",
  });
});

test("a listing passes its query and follows every page", async () => {
  const pages = [
    { users: [{ ...USER, id: "PFIRST", email: "first@example.com" }], more: true },
    { users: [USER], more: false },
  ];
  const { client, calls } = server(() => json(pages.shift()));
  expect(await client.findUserByEmail("oncall@example.com")).toMatchObject({ id: "PUSER01" });
  const [first, second] = calls;
  expect(first?.url.pathname).toBe("/users");
  expect(first?.url.searchParams.get("query")).toBe("oncall@example.com");
  expect(first?.url.searchParams.get("limit")).toBe("100");
  expect(first?.url.searchParams.get("offset")).toBe("0");
  expect(second?.url.searchParams.get("offset")).toBe("1");
});

test("every write names the from user, and a note comes back with its author", async () => {
  const { client, calls } = server(() => json({ note: NOTE }, 201));
  expect(await client.createNote("Q1ABCDEF", "jigs is looking")).toEqual(NOTE);
  expect(calls[0]).toMatchObject({
    method: "POST",
    headers: {
      authorization: "Bearer token-1",
      accept: "application/vnd.pagerduty+json;version=2",
      "content-type": "application/json",
      from: "oncall@example.com",
    },
    json: { note: { content: "jigs is looking" } },
  });
  expect(calls[0]?.url.pathname).toBe("/incidents/Q1ABCDEF/notes");
});

test("a 401 gets a new token and retries once", async () => {
  let first = true;
  const { client, calls, tokens } = server(() => {
    if (first) {
      first = false;
      return json({ error: { message: "Unauthorized", code: 2006 } }, 401);
    }
    return json({ note: NOTE }, 201);
  });
  expect(await client.createNote("Q1ABCDEF", "hello")).toEqual(NOTE);
  expect(tokens.minted()).toBe(2);
  expect(calls.map((call) => call.headers.authorization)).toEqual([
    "Bearer token-1",
    "Bearer token-2",
  ]);
  expect(calls[1]?.headers.from).toBe("oncall@example.com");
});

test("a second 401 is the caller's error, not another retry", async () => {
  const { client, calls } = server(() =>
    json({ error: { message: "Unauthorized", code: 2006 } }, 401),
  );
  const err = await rejection<ProviderApiError>(client.getIncident("Q1"));
  expect(err).toBeInstanceOf(ProviderApiError);
  expect(err).toMatchObject({ provider: "pagerduty", status: 401 });
  expect(calls).toHaveLength(2);
});

test("a 429 waits out ratelimit-reset and tries again", async () => {
  const replies = [
    json({ error: { message: "Rate Limit Exceeded", code: 2020 } }, 429, {
      "ratelimit-limit": "960",
      "ratelimit-remaining": "0",
      "ratelimit-reset": "7",
    }),
    json({ incident: INCIDENT }),
  ];
  const { client, sleeps, calls } = server(() => replies.shift() as Response);
  expect(await client.getIncident("Q1ABCDEF")).toEqual(INCIDENT);
  expect(sleeps).toEqual([7000]);
  expect(calls).toHaveLength(2);
});

test("a 429 whose reset is too far off fails at once, naming the wait", async () => {
  const { client, sleeps } = server(() =>
    json({ error: { message: "Rate Limit Exceeded" } }, 429, { "ratelimit-reset": "600" }),
  );
  await expect(client.getIncident("Q1")).rejects.toThrow("rate limited for 600s");
  expect(sleeps).toEqual([]);
});

test("repeated 429s give up after a bounded number of waits", async () => {
  const { client, sleeps } = server(() =>
    json({ error: { message: "Rate Limit Exceeded" } }, 429, { "ratelimit-reset": "1" }),
  );
  await expect(client.getIncident("Q1")).rejects.toMatchObject({ status: 429 });
  expect(sleeps).toEqual([1000, 1000, 1000]);
});

test("a 400 carries PagerDuty's error and the request", async () => {
  const { client } = server(() =>
    json({ error: { message: "Invalid Input Provided", code: 1027, errors: ["From"] } }, 400),
  );
  const err = await rejection<ProviderApiError>(client.createNote("Q1", "x"));
  expect(err.status).toBe(400);
  expect(err.message).toContain("POST /incidents/Q1/notes");
  expect(err.message).toContain("1027");
  expect(err.message).not.toContain("token-1");
});

test("a user is found by exact email, case-insensitively", async () => {
  const { client, calls } = server(() =>
    json({
      users: [
        { ...USER, id: "PNEAR", email: "oncall@example.com.au" },
        { ...USER, email: "OnCall@Example.com" },
      ],
      more: false,
    }),
  );
  expect(await client.findUserByEmail("oncall@example.com")).toMatchObject({ id: "PUSER01" });
  expect(calls[0]?.url.pathname).toBe("/users");
  expect(calls[0]?.url.searchParams.get("query")).toBe("oncall@example.com");
});

test("no user with the email reads as null", async () => {
  const { client } = server(() => json({ users: [], more: false }));
  expect(await client.findUserByEmail("nobody@example.com")).toBeNull();
});

test("the access probe is one small incident read", async () => {
  const { client, calls } = server(() => json({ incidents: [], more: false }));
  await client.verifyAccess();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url.pathname).toBe("/incidents");
  expect(calls[0]?.url.searchParams.get("limit")).toBe("1");
});

test("a list that never ends stops at PagerDuty's offset ceiling with a repair", async () => {
  const { client, calls } = server(() =>
    json({ users: Array.from({ length: 100 }, () => USER), more: true }),
  );
  const err = await rejection<Error & { hint?: string }>(client.findUserByEmail("x@example.com"));
  expect(err.name).toBe("JigsError");
  expect(err.message).toContain("past 10000 records on /users");
  expect(err.hint).toContain("narrow the query");
  expect(calls).toHaveLength(100);
});
