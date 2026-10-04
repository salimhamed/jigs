import { generateKeyPairSync } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveFactoryContext } from "../config/factory-context.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import {
  appBotFor,
  createGithubAuth,
  mintAppJwt,
  mintInstallationToken,
  readAppPrivateKey,
} from "./github-auth.ts";
import { useGithubClient } from "./test-fixtures.ts";
import { fakeFetch, jsonResponse } from "./test-support.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const APP = {
  mode: "app",
  appId: 4958325,
  installationId: 162033982,
  privateKeyPath: "/key.pem",
  operator: "salimhamed",
} as const;

const NOW = Date.parse("2026-09-15T12:00:00Z");
const decode = (segment: string) => JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  vi.restoreAllMocks();
  removeTmpDir(tmp);
});

const tokenResponse = (token: string, expiresAt: number) =>
  jsonResponse({ token, expires_at: new Date(expiresAt).toISOString() });

// GitHub answering each call with the next reply, in order.
function github(...replies: Response[]) {
  const fake = fakeFetch(() => {
    const reply = replies.shift();
    if (reply === undefined) throw new Error("no reply left");
    return reply;
  });
  useGithubClient({ fetch: fake.fetch });
  return fake;
}

test("the JWT is RS256, backdated a minute, and expires inside GitHub's ten", () => {
  const [header, payload, signature] = mintAppJwt(APP.appId, privateKey, NOW).split(".");
  expect(decode(String(header))).toEqual({ alg: "RS256", typ: "JWT" });
  const claims = decode(String(payload));
  expect(claims.iss).toBe(APP.appId);
  expect(claims.iat).toBe(NOW / 1000 - 60);
  expect(claims.exp - claims.iat).toBe(600);
  expect(claims.exp - NOW / 1000).toBeLessThanOrEqual(600);
  expect(signature).not.toBe("");
});

test("the installation token is exchanged for the JWT at the installation's endpoint", async () => {
  const { calls } = github(tokenResponse("ghs_minted", NOW + 3_600_000));
  const minted = await mintInstallationToken(APP, privateKey, { now: () => NOW });

  expect(minted).toEqual({ token: "ghs_minted", expiresAt: NOW + 3_600_000 });
  expect(calls[0]?.url.href).toBe(
    `https://api.github.com/app/installations/${APP.installationId}/access_tokens`,
  );
  expect(calls[0]?.method).toBe("POST");
  expect(calls[0]?.headers.authorization).toBe(`Bearer ${mintAppJwt(APP.appId, privateKey, NOW)}`);
});

test("a minted token is reused until five minutes are left, then re-minted", async () => {
  let now = NOW;
  const { calls } = github(
    tokenResponse("first", NOW + 3_600_000),
    tokenResponse("second", NOW + 7_200_000),
  );
  const auth = createGithubAuth(APP, {
    env: () => undefined,
    now: () => now,
    readPrivateKey: () => ({ key: privateKey }),
  });

  expect(await auth.bearer()).toBe("first");
  expect(await auth.bearer()).toBe("first");
  now = NOW + 3_600_000 - 5 * 60_000 - 1;
  expect(await auth.bearer()).toBe("first");
  // Inside the margin: renew while there is still time to fail and retry.
  now += 2;
  expect(await auth.bearer()).toBe("second");
  expect(calls).toHaveLength(2);
});

test("a caller can ask for a token with more time left than jigs' own margin", async () => {
  let now = NOW;
  const { calls } = github(
    tokenResponse("first", NOW + 3_600_000),
    tokenResponse("second", NOW + 600_000 + 3_600_000),
  );
  const auth = createGithubAuth(APP, {
    env: () => undefined,
    now: () => now,
    readPrivateKey: () => ({ key: privateKey }),
  });
  expect(await auth.bearer()).toBe("first");
  now = NOW + 4 * 60_000;
  expect(await auth.bearer(55 * 60_000)).toBe("first");
  now = NOW + 10 * 60_000;
  // jigs' own calls would keep the first token for another 45 minutes.
  expect(await auth.bearer(55 * 60_000)).toBe("second");
  expect(await auth.bearer()).toBe("second");
  expect(calls).toHaveLength(2);
});

test("the App's bot is looked up once per App, as <slug>[bot] with its user id", async () => {
  const { calls } = github(
    jsonResponse({ slug: "jigs-dev", name: "jigs dev" }),
    jsonResponse({ id: 4242, login: "jigs-dev[bot]" }),
  );
  const bearer = vi.fn(async () => "ghs_token");
  const deps = { readPrivateKey: () => ({ key: privateKey }) };
  const bot = await appBotFor(APP, bearer, deps);
  expect(bot).toEqual({ login: "jigs-dev[bot]", id: 4242 });
  expect(await appBotFor({ ...APP, installationId: 7 }, bearer, deps)).toBe(bot);
  expect(calls.map((call) => call.url.href)).toEqual([
    "https://api.github.com/app",
    "https://api.github.com/users/jigs-dev%5Bbot%5D",
  ]);
});

test("a rejected exchange names the configuration, and never the token", async () => {
  github(new Response("nope", { status: 401 }));
  const failure: unknown = await mintInstallationToken(APP, privateKey, {
    now: () => NOW,
  }).catch((err: unknown) => err);

  expect(failure).toMatchObject({
    message: expect.stringContaining(String(APP.appId)),
    hint: expect.stringContaining("privateKeyPath"),
  });
});

test("no minted token ever reaches a log line or an error message", async () => {
  const logged: unknown[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args) => logged.push(...args));
  github(tokenResponse("ghs_secret_value", NOW + 3_600_000));
  const auth = createGithubAuth(APP, {
    env: () => undefined,
    now: () => NOW,
    readPrivateKey: () => ({ key: privateKey }),
  });
  expect(await auth.bearer()).toBe("ghs_secret_value");
  expect(JSON.stringify(logged)).not.toContain("ghs_secret_value");
  log.mockRestore();
});

test("pat mode is the environment's token, and says so when there is none", async () => {
  const auth = createGithubAuth({ mode: "pat" }, { env: () => "ghp_from_env" });
  expect(await auth.bearer()).toBe("ghp_from_env");
  expect(auth.invalidate).toBeUndefined();
  const empty = createGithubAuth({ mode: "pat" }, { env: () => "" });
  await expect(empty.bearer()).rejects.toThrow("GITHUB_TOKEN is not set");
});

test("a private key readable by anyone on the machine is reported, not refused", () => {
  const file = path.join(tmp, "key.pem");
  writeFileSync(file, privateKey, { mode: 0o600 });
  expect(readAppPrivateKey(file)).toEqual({ key: privateKey });
  chmodSync(file, 0o644);
  expect(readAppPrivateKey(file)).toMatchObject({ looseMode: "0644" });
});

test("a missing or non-PEM key file names the repair", () => {
  expect(() => readAppPrivateKey(path.join(tmp, "absent.pem"))).toThrow("cannot read");
  const file = path.join(tmp, "not-a-key.pem");
  writeFileSync(file, "hello");
  expect(() => readAppPrivateKey(file)).toThrow("not a PEM private key");
});

test("callers that arrive together share one mint rather than each making their own", async () => {
  const { calls } = github(tokenResponse("shared", NOW + 3_600_000));
  const auth = createGithubAuth(APP, {
    env: () => undefined,
    now: () => NOW,
    readPrivateKey: () => ({ key: privateKey }),
  });
  // What a snapshot does: six reads, none of them waiting for the others.
  const tokens = await Promise.all(Array.from({ length: 6 }, () => auth.bearer()));
  expect(tokens).toEqual(Array(6).fill("shared"));
  expect(calls).toHaveLength(1);
});

test("a failed mint is not cached, so the next caller tries again", async () => {
  github(new Response("nope", { status: 401 }), tokenResponse("second-time", NOW + 3_600_000));
  const auth = createGithubAuth(APP, {
    env: () => undefined,
    now: () => NOW,
    readPrivateKey: () => ({ key: privateKey }),
  });
  await expect(auth.bearer()).rejects.toThrow();
  expect(await auth.bearer()).toBe("second-time");
});

test("accounts select independent cached installation tokens across Apps", async () => {
  const { githubAuthFor } = await import("./github-auth.ts");
  const { installationId: _, ...app } = APP;
  writeFileSync(path.join(tmp, "key.pem"), privateKey, { mode: 0o600 });
  writeFileSync(
    path.join(tmp, "jigs.config.ts"),
    `export default ${JSON.stringify({
      service: { dashboardPort: 9090 },
      github: {
        identities: [
          { ...app, privateKeyPath: "key.pem", installations: { First: 10, Second: 20 } },
          { ...app, appId: 999, privateKeyPath: "key.pem", installations: { Third: 10 } },
        ],
      },
    })}`,
  );
  const { fetch: doFetch, calls } = fakeFetch(() =>
    tokenResponse(`token-${calls.length}`, Date.now() + 3_600_000),
  );
  useGithubClient({ fetch: doFetch });
  const ctx = resolveFactoryContext(tmp);
  expect(await githubAuthFor("FIRST", ctx).bearer()).toBe("token-1");
  // The process keeps its factory configuration after the file changes.
  writeFileSync(
    path.join(tmp, "jigs.config.ts"),
    'export default { service: { dashboardPort: 9090 }, github: { identities: [{ mode: "pat" }] } }',
  );
  expect(await githubAuthFor("first", ctx).bearer()).toBe("token-1");
  expect(await githubAuthFor("Second", ctx).bearer()).toBe("token-2");
  expect(await githubAuthFor("Third", ctx).bearer()).toBe("token-3");
  expect(calls).toHaveLength(3);
  expect(calls[0]?.url.pathname).toBe("/app/installations/10/access_tokens");
  expect(calls[1]?.url.pathname).toBe("/app/installations/20/access_tokens");
  expect(() => githubAuthFor("uncovered", ctx)).toThrow("account uncovered");
  // A new context starts with no credentials, but does not reload the process's config.
  expect(() => githubAuthFor("uncovered", resolveFactoryContext(tmp))).toThrow("account uncovered");
});

test("a token GitHub rejects is minted again once, so a revoked token does not wait out its hour", async () => {
  const { calls } = github(
    tokenResponse("revoked", NOW + 3_600_000),
    jsonResponse({ message: "Bad credentials" }, 401),
    tokenResponse("fresh", NOW + 3_600_000),
    jsonResponse({ id: 1 }),
  );
  const auth = createGithubAuth(APP, {
    env: () => undefined,
    now: () => NOW,
    readPrivateKey: () => ({ key: privateKey }),
  });
  const { githubSend } = await import("./github-http.ts");
  await expect(githubSend({ auth, apiPath: "/repos/acme/api" })).resolves.toEqual({ id: 1 });
  expect(calls.map((call) => call.headers.authorization)).toEqual([
    expect.stringMatching(/^Bearer ey/),
    "Bearer revoked",
    expect.stringMatching(/^Bearer ey/),
    "Bearer fresh",
  ]);
});

test("a rejected personal token is not retried", async () => {
  const { calls } = github(jsonResponse({ message: "Bad credentials" }, 401));
  const auth = createGithubAuth({ mode: "pat" }, { env: () => "ghp_revoked" });
  const { githubSend, GitHubApiError } = await import("./github-http.ts");
  const failure = await githubSend({ auth, apiPath: "/repos/acme/api" }).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(GitHubApiError);
  expect(failure).toMatchObject({ status: 401, githubMessage: "Bad credentials" });
  expect(calls).toHaveLength(1);
});
