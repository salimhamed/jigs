import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { useFactoryRoot } from "./github-auth.ts";
import { getViewer } from "./linear.ts";
import {
  createLinearAuth,
  linearAuthFor,
  missingLinearVariables,
  resetLinearAuth,
  resolveLinearIdentity,
} from "./linear-auth.ts";

let tmp: string;

beforeEach(() => {
  tmp = makeTmpDir();
  vi.stubEnv("LINEAR_API_URL", "http://linear.test/graphql");
  for (const name of ["LINEAR_API_KEY", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"])
    vi.stubEnv(name, "");
});
afterEach(() => {
  resetLinearAuth();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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
  expect(await auth.authorization()).toBe("lin_key");
});

test("an app identity mints a client-credentials token once and sends it as a bearer", async () => {
  const doFetch = vi.fn(async () => tokenResponse("app-token"));
  const auth = createLinearAuth({ mode: "app" }, { env: lookup(APP_ENV), fetch: doFetch });
  // Concurrent first calls share the one mint.
  expect(await Promise.all([auth.authorization(), auth.authorization()])).toEqual([
    "Bearer app-token",
    "Bearer app-token",
  ]);
  // expires_in is advisory: the cached token is kept past it.
  expect(await auth.authorization()).toBe("Bearer app-token");
  expect(doFetch).toHaveBeenCalledTimes(1);
  const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("http://linear.test/oauth/token");
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
  expect(await auth.authorization()).toBe("Bearer token-1");
  auth.invalidate();
  expect(await auth.authorization()).toBe("Bearer token-2");
});

test("a refused mint names the client variables", async () => {
  const doFetch = vi.fn(async () => new Response('{"error":"invalid_client"}', { status: 401 }));
  const auth = createLinearAuth({ mode: "app" }, { env: lookup(APP_ENV), fetch: doFetch });
  await expect(auth.authorization()).rejects.toThrow("HTTP 401");
  await expect(auth.authorization()).rejects.toMatchObject({
    hint: expect.stringContaining("LINEAR_CLIENT_SECRET"),
  });
});

test("a missing variable is named along with the mode that needs it", async () => {
  const doFetch = vi.fn();
  await expect(
    createLinearAuth({ mode: "key" }, { env: lookup({}) }).authorization(),
  ).rejects.toThrow('LINEAR_API_KEY is not set, and linear.identity mode "key" needs it');
  await expect(
    createLinearAuth(
      { mode: "app" },
      { env: lookup({ LINEAR_CLIENT_ID: "id" }), fetch: doFetch },
    ).authorization(),
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
  expect(await linearAuthFor().authorization()).toBe("from-shell");
});

test("a factory's key comes from its .env", async () => {
  writeFactory({ mode: "key" }, "LINEAR_API_KEY=from-dotenv\n");
  useFactoryRoot(tmp);
  expect(await linearAuthFor().authorization()).toBe("from-dotenv");
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
  const calls: Array<{ url: string; authorization?: string }> = [];
  let minted = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const authorization = (init.headers as Record<string, string>).authorization;
      calls.push({ url, authorization });
      if (url.endsWith("/oauth/token")) return tokenResponse(`token-${++minted}`);
      const status = graphqlStatuses.shift() ?? 200;
      if (status === "auth-error") return new Response(JSON.stringify(AUTHENTICATION_ERROR));
      return status === 200
        ? new Response(JSON.stringify({ data: { viewer: { id: "u1", name: "jigs" } } }))
        : new Response("authentication required", { status });
    }),
  );
  return calls;
}

test("an app token Linear rejects is re-minted and the call retried once", async () => {
  writeFactory({ mode: "app" }, "LINEAR_CLIENT_ID=id\nLINEAR_CLIENT_SECRET=secret\n");
  useFactoryRoot(tmp);
  const calls = graphqlServer([401]);
  expect(await getViewer()).toEqual({ id: "u1", name: "jigs" });
  expect(calls.map((call) => [call.url, call.authorization])).toEqual([
    ["http://linear.test/oauth/token", undefined],
    ["http://linear.test/graphql", "Bearer token-1"],
    ["http://linear.test/oauth/token", undefined],
    ["http://linear.test/graphql", "Bearer token-2"],
  ]);
});

test("an AUTHENTICATION_ERROR under a 200 re-mints the app token once", async () => {
  writeFactory({ mode: "app" }, "LINEAR_CLIENT_ID=id\nLINEAR_CLIENT_SECRET=secret\n");
  useFactoryRoot(tmp);
  const calls = graphqlServer(["auth-error"]);
  expect(await getViewer()).toEqual({ id: "u1", name: "jigs" });
  expect(calls.map((call) => call.authorization)).toEqual([
    undefined,
    "Bearer token-1",
    undefined,
    "Bearer token-2",
  ]);
});

test("a second 401 after a re-mint is thrown, not retried again", async () => {
  writeFactory({ mode: "app" }, "LINEAR_CLIENT_ID=id\nLINEAR_CLIENT_SECRET=secret\n");
  useFactoryRoot(tmp);
  const calls = graphqlServer([401, 401]);
  await expect(getViewer()).rejects.toThrow("Linear API 401");
  expect(calls.filter((call) => call.url.endsWith("/graphql"))).toHaveLength(2);
});

test("a rejected personal key is not retried", async () => {
  writeFactory({ mode: "key" }, "LINEAR_API_KEY=stale\n");
  useFactoryRoot(tmp);
  const calls = graphqlServer([401]);
  await expect(getViewer()).rejects.toThrow("Linear API 401");
  expect(calls).toHaveLength(1);
});
