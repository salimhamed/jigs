import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { resetProviderContext, useFactoryRoot } from "./credentials.ts";
import { createLinearClient } from "./linear.ts";
import {
  createLinearAuth,
  LINEAR_API_URL,
  LINEAR_TOKEN_URL,
  linearAuthFor,
  missingLinearVariables,
  resolveLinearIdentity,
} from "./linear-auth.ts";
import { fakeFetch, fakeSleep, jsonResponse } from "./test-support.ts";

let tmp: string;

beforeEach(() => {
  tmp = makeTmpDir();
  for (const name of ["LINEAR_API_KEY", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"])
    vi.stubEnv(name, "");
});
afterEach(() => {
  resetProviderContext();
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

const APP_ENV: Record<string, string> = {
  LINEAR_CLIENT_ID: "client-id",
  LINEAR_CLIENT_SECRET: "client-secret",
};
const lookup = (values: Record<string, string>) => (name: string) => values[name];

const tokenResponse = (token: string) =>
  new Response(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 1 }), {
    status: 200,
  });

function writeFactory(identity: unknown, env: string): void {
  writeFileSync(
    path.join(tmp, "jigs.config.ts"),
    `export default ${JSON.stringify({ service: { dashboardPort: 9090 }, linear: { identity } })}`,
  );
  writeFileSync(path.join(tmp, ".env"), env);
}

test("a key identity sends the raw key, with no Bearer prefix", async () => {
  const auth = createLinearAuth({ mode: "key" }, { env: lookup({ LINEAR_API_KEY: "lin_key" }) });
  expect(await auth.bearer()).toBe("lin_key");
  expect(auth.invalidate).toBeUndefined();
  const server = fakeFetch(() => jsonResponse({ data: { viewer: { id: "u1", name: "jigs" } } }));
  await createLinearClient({ auth, fetch: server.fetch }).getViewer();
  expect(server.calls[0]?.headers.authorization).toBe("lin_key");
});

test("an app identity's minted token is sent as a bearer", async () => {
  const doFetch = vi.fn(async () => tokenResponse("app-token"));
  const auth = createLinearAuth({ mode: "app" }, { env: lookup(APP_ENV), fetch: doFetch });
  expect(await auth.bearer()).toBe("app-token");
  const server = fakeFetch(() => jsonResponse({ data: { viewer: { id: "u1", name: "jigs" } } }));
  await createLinearClient({ auth, fetch: server.fetch }).getViewer();
  expect(server.calls[0]?.headers.authorization).toBe("Bearer app-token");
  expect(doFetch).toHaveBeenCalledTimes(1);
});

test("an app identity mints a client-credentials token once", async () => {
  const doFetch = vi.fn(async () => tokenResponse("app-token"));
  const auth = createLinearAuth({ mode: "app" }, { env: lookup(APP_ENV), fetch: doFetch });
  // Concurrent first calls share the one mint.
  expect(await Promise.all([auth.bearer(), auth.bearer()])).toEqual(["app-token", "app-token"]);
  // expires_in is advisory: the cached token is kept past it.
  expect(await auth.bearer()).toBe("app-token");
  expect(doFetch).toHaveBeenCalledTimes(1);
  const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(LINEAR_TOKEN_URL);
  expect(init.method).toBe("POST");
  expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({
    grant_type: "client_credentials",
    scope: "read,write",
    client_id: "client-id",
    client_secret: "client-secret",
  });
});

test("invalidating an app token mints a fresh one on the next call", async () => {
  let minted = 0;
  const doFetch = vi.fn(async () => tokenResponse(`token-${++minted}`));
  const auth = createLinearAuth({ mode: "app" }, { env: lookup(APP_ENV), fetch: doFetch });
  expect(await auth.bearer()).toBe("token-1");
  auth.invalidate?.("token-1");
  expect(await auth.bearer()).toBe("token-2");
  // A late rejection of the old token keeps the new one.
  auth.invalidate?.("token-1");
  expect(await auth.bearer()).toBe("token-2");
  expect(doFetch).toHaveBeenCalledTimes(2);
});

test("a refused mint names the client variables", async () => {
  const doFetch = vi.fn(async () => new Response('{"error":"invalid_client"}', { status: 401 }));
  const auth = createLinearAuth({ mode: "app" }, { env: lookup(APP_ENV), fetch: doFetch });
  await expect(auth.bearer()).rejects.toThrow("HTTP 401");
  await expect(auth.bearer()).rejects.toMatchObject({
    hint: expect.stringContaining("LINEAR_CLIENT_SECRET"),
  });
});

test("a missing variable is named along with the mode that needs it", async () => {
  const doFetch = vi.fn();
  await expect(createLinearAuth({ mode: "key" }, { env: lookup({}) }).bearer()).rejects.toThrow(
    'LINEAR_API_KEY is not set, and linear.identity mode "key" needs it',
  );
  await expect(
    createLinearAuth(
      { mode: "app" },
      { env: lookup({ LINEAR_CLIENT_ID: "id" }), fetch: doFetch },
    ).bearer(),
  ).rejects.toThrow('LINEAR_CLIENT_SECRET is not set, and linear.identity mode "app" needs it');
  expect(doFetch).not.toHaveBeenCalled();
  expect(missingLinearVariables({ mode: "app" }, lookup({}))).toEqual([
    "LINEAR_CLIENT_ID",
    "LINEAR_CLIENT_SECRET",
  ]);
});

test("outside a factory the identity is a key read from the shell", async () => {
  expect(resolveLinearIdentity()).toEqual({ mode: "key" });
  vi.stubEnv("LINEAR_API_KEY", "from-shell");
  expect(await linearAuthFor().bearer()).toBe("from-shell");
});

test("a factory's key comes from its .env", async () => {
  writeFactory({ mode: "key" }, "LINEAR_API_KEY=from-dotenv\n");
  useFactoryRoot(tmp);
  expect(await linearAuthFor().bearer()).toBe("from-dotenv");
});

const AUTHENTICATION_ERROR = {
  errors: [
    {
      message: "Authentication required, not authenticated",
      extensions: { type: "authentication error", code: "AUTHENTICATION_ERROR", statusCode: 401 },
    },
  ],
};

function graphqlServer(graphqlStatuses: Array<number | "auth-error">) {
  let minted = 0;
  const server = fakeFetch((call) => {
    if (call.url.toString() === LINEAR_TOKEN_URL) return tokenResponse(`token-${++minted}`);
    const status = graphqlStatuses.shift() ?? 200;
    if (status === "auth-error") return jsonResponse(AUTHENTICATION_ERROR);
    return status === 200
      ? jsonResponse({ data: { viewer: { id: "u1", name: "jigs" } } })
      : new Response("authentication required", { status });
  });
  const auth = (identity: "key" | "app") =>
    createLinearAuth(
      { mode: identity },
      {
        env: lookup(identity === "key" ? { LINEAR_API_KEY: "stale" } : APP_ENV),
        fetch: server.fetch,
      },
    );
  const client = (identity: "key" | "app") =>
    createLinearClient({ auth: auth(identity), fetch: server.fetch });
  return { calls: server.calls, client };
}

test("an app token Linear rejects is re-minted and the call retried once", async () => {
  const { calls, client } = graphqlServer([401]);
  expect(await client("app").getViewer()).toEqual({ id: "u1", name: "jigs" });
  expect(calls.map((call) => [call.url.toString(), call.headers.authorization])).toEqual([
    [LINEAR_TOKEN_URL, undefined],
    [LINEAR_API_URL, "Bearer token-1"],
    [LINEAR_TOKEN_URL, undefined],
    [LINEAR_API_URL, "Bearer token-2"],
  ]);
});

test("an AUTHENTICATION_ERROR under a 200 re-mints the app token once", async () => {
  const { calls, client } = graphqlServer(["auth-error"]);
  expect(await client("app").getViewer()).toEqual({ id: "u1", name: "jigs" });
  expect(calls.map((call) => call.headers.authorization)).toEqual([
    undefined,
    "Bearer token-1",
    undefined,
    "Bearer token-2",
  ]);
});

test("a second 401 after a re-mint is thrown, not retried again", async () => {
  const { calls, client } = graphqlServer([401, 401]);
  await expect(client("app").getViewer()).rejects.toThrow("Linear API 401 on Viewer");
  expect(calls.filter((call) => call.url.toString() === LINEAR_API_URL)).toHaveLength(2);
});

test("a rejected personal key is not retried", async () => {
  const { calls, client } = graphqlServer([401]);
  await expect(client("key").getViewer()).rejects.toThrow("Linear API 401");
  expect(calls).toHaveLength(1);
});

test("a rate-limited call waits as Linear asks, then retries", async () => {
  const server = fakeFetch(() =>
    server.calls.length === 1
      ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
      : jsonResponse({ data: { viewer: { id: "u1", name: "jigs" } } }),
  );
  const { sleep, sleeps } = fakeSleep();
  const client = createLinearClient({
    auth: createLinearAuth({ mode: "key" }, { env: lookup({ LINEAR_API_KEY: "k" }) }),
    fetch: server.fetch,
    sleep,
  });
  expect(await client.getViewer()).toEqual({ id: "u1", name: "jigs" });
  expect(sleeps).toEqual([2000]);
  expect(server.calls).toHaveLength(2);
});
