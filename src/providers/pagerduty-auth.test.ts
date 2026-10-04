import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PagerDutyIdentity } from "../config/factory-config.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { setCredentialRoot } from "./credential-root.ts";
import { useFactoryRoot } from "./github-auth.ts";
import {
  createPagerDutyAuth,
  missingPagerDutyVariables,
  PAGERDUTY_TOKEN_URL,
  pagerDutyAuthFor,
  pagerDutyScope,
  resetPagerDutyAuth,
  resolvePagerDutyIdentity,
} from "./pagerduty-auth.ts";

async function rejection<E>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (err) {
    return err as E;
  }
  throw new Error("expected a rejection");
}

const IDENTITY: PagerDutyIdentity = {
  mode: "app",
  subdomain: "acme",
  region: "us",
  from: "oncall@example.com",
};
const SECRET = "pd-client-secret-value";
const ENV: Record<string, string> = {
  PAGERDUTY_CLIENT_ID: "pd-client-id",
  PAGERDUTY_CLIENT_SECRET: SECRET,
};
const lookup = (values: Record<string, string>) => (name: string) => values[name];

// The shape identity.pagerduty.com answers a client-credentials grant with.
const tokenResponse = (token: string, expiresIn = 86400) =>
  new Response(
    JSON.stringify({
      access_token: token,
      token_type: "bearer",
      expires_in: expiresIn,
      scope: pagerDutyScope(IDENTITY),
      id_token: null,
    }),
    { status: 200 },
  );

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
  for (const name of Object.keys(ENV)) vi.stubEnv(name, "");
});
afterEach(() => {
  resetPagerDutyAuth();
  setCredentialRoot(null);
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

test("the scope names the account by region and subdomain, then the v1 scopes", () => {
  expect(pagerDutyScope(IDENTITY)).toBe(
    "as_account-us.acme incidents.read incidents.write webhook_subscriptions.read users.read",
  );
  expect(pagerDutyScope({ ...IDENTITY, region: "eu" })).toMatch(/^as_account-eu\.acme /);
});

test("a token is minted once with client credentials and cached", async () => {
  const doFetch = vi.fn(async () => tokenResponse("token-1"));
  const auth = createPagerDutyAuth(IDENTITY, { env: lookup(ENV), fetch: doFetch });
  // Concurrent first calls share the one mint.
  expect(await Promise.all([auth.bearer(), auth.bearer()])).toEqual(["token-1", "token-1"]);
  expect(await auth.bearer()).toBe("token-1");
  expect(doFetch).toHaveBeenCalledTimes(1);
  const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(PAGERDUTY_TOKEN_URL);
  expect(init.method).toBe("POST");
  expect((init.headers as Record<string, string>)["content-type"]).toBe(
    "application/x-www-form-urlencoded",
  );
  expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({
    grant_type: "client_credentials",
    client_id: "pd-client-id",
    client_secret: SECRET,
    scope: pagerDutyScope(IDENTITY),
  });
});

test("invalidating a token mints a fresh one on the next call", async () => {
  let minted = 0;
  const doFetch = vi.fn(async () => tokenResponse(`token-${++minted}`));
  const auth = createPagerDutyAuth(IDENTITY, { env: lookup(ENV), fetch: doFetch });
  expect(await auth.bearer()).toBe("token-1");
  auth.invalidate("token-1");
  expect(await auth.bearer()).toBe("token-2");
});

test("a late 401 on an old token keeps the token minted since", async () => {
  let minted = 0;
  const doFetch = vi.fn(async () => tokenResponse(`token-${++minted}`));
  const auth = createPagerDutyAuth(IDENTITY, { env: lookup(ENV), fetch: doFetch });
  expect(await auth.bearer()).toBe("token-1");
  auth.invalidate("token-1");
  expect(await auth.bearer()).toBe("token-2");
  auth.invalidate("token-1");
  expect(await auth.bearer()).toBe("token-2");
  expect(doFetch).toHaveBeenCalledTimes(2);
});

test("a token response that is not JSON fails cleanly, without echoing the body", async () => {
  const doFetch = vi.fn(async () => new Response(`<html>${SECRET}</html>`, { status: 200 }));
  const auth = createPagerDutyAuth(IDENTITY, { env: lookup(ENV), fetch: doFetch });
  const err = await rejection<Error>(auth.bearer());
  expect(err.name).toBe("JigsError");
  expect(err.message).toBe("PagerDuty's token response (HTTP 200) was not JSON");
});

test("a token is reused until it expires, then replaced", async () => {
  let minted = 0;
  let now = 0;
  const doFetch = vi.fn(async () => tokenResponse(`token-${++minted}`, 3600));
  const auth = createPagerDutyAuth(IDENTITY, { env: lookup(ENV), fetch: doFetch, now: () => now });
  expect(await auth.bearer()).toBe("token-1");
  now = 3_599_999;
  expect(await auth.bearer()).toBe("token-1");
  now = 3_600_000;
  expect(await auth.bearer()).toBe("token-2");
});

test("a caller that needs a longer lifetime gets a fresh token", async () => {
  let minted = 0;
  let now = 0;
  const doFetch = vi.fn(async () => tokenResponse(`token-${++minted}`, 3600));
  const auth = createPagerDutyAuth(IDENTITY, { env: lookup(ENV), fetch: doFetch, now: () => now });
  expect(await auth.bearer()).toBe("token-1");
  now = 1_000;
  expect(await auth.bearer(3_598_999)).toBe("token-1");
  expect(await auth.bearer(3_599_000)).toBe("token-2");
});

test("a refused mint names the .env keys and never echoes the secret", async () => {
  const doFetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: "invalid_client",
          error_description: `client_secret ${SECRET} is wrong`,
        }),
        { status: 401 },
      ),
  );
  const auth = createPagerDutyAuth(IDENTITY, { env: lookup(ENV), fetch: doFetch });
  const err = await rejection<Error & { hint?: string }>(auth.bearer());
  expect(err.message).toContain("HTTP 401");
  expect(err.message).toContain("invalid_client");
  expect(err.message).not.toContain(SECRET);
  expect(err.hint).toContain("PAGERDUTY_CLIENT_ID and PAGERDUTY_CLIENT_SECRET");
  expect(err.hint).not.toContain(SECRET);
});

test("a token response without an access token fails without echoing the body", async () => {
  const doFetch = vi.fn(async () => new Response(JSON.stringify({ echo: SECRET })));
  const auth = createPagerDutyAuth(IDENTITY, { env: lookup(ENV), fetch: doFetch });
  const err = await rejection<Error>(auth.bearer());
  expect(err.message).toContain("no access_token");
  expect(err.message).not.toContain(SECRET);
});

test("a missing variable is named before anything is fetched", async () => {
  const doFetch = vi.fn();
  await expect(
    createPagerDutyAuth(IDENTITY, {
      env: lookup({ PAGERDUTY_CLIENT_ID: "id" }),
      fetch: doFetch,
    }).bearer(),
  ).rejects.toThrow("PAGERDUTY_CLIENT_SECRET is not set");
  expect(doFetch).not.toHaveBeenCalled();
  expect(missingPagerDutyVariables(lookup({}))).toEqual([
    "PAGERDUTY_CLIENT_ID",
    "PAGERDUTY_CLIENT_SECRET",
  ]);
});

function writeFactory(pagerduty: unknown): void {
  writeFileSync(
    path.join(tmp, "jigs.config.ts"),
    `export default ${JSON.stringify({ service: { dashboardPort: 9090 }, pagerduty })}`,
  );
}

test("the identity is read from the factory config", () => {
  writeFactory({ identity: IDENTITY });
  useFactoryRoot(tmp);
  expect(resolvePagerDutyIdentity()).toEqual(IDENTITY);
  expect(pagerDutyAuthFor().identity).toEqual(IDENTITY);
  expect(pagerDutyAuthFor()).toBe(pagerDutyAuthFor());
});

test("a factory without a pagerduty section says where to add one", () => {
  writeFactory(undefined);
  useFactoryRoot(tmp);
  expect(() => resolvePagerDutyIdentity()).toThrow("jigs.config.ts has no pagerduty section");
});
