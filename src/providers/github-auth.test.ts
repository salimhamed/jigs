import { generateKeyPairSync } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import {
  createGithubAuth,
  mintAppJwt,
  mintInstallationToken,
  readAppPrivateKey,
} from "./github-auth.ts";

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
  vi.stubEnv("GITHUB_API_URL", "http://mock.test/github");
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

const tokenResponse = (token: string, expiresAt: number) =>
  new Response(JSON.stringify({ token, expires_at: new Date(expiresAt).toISOString() }));

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
  const doFetch = vi.fn().mockResolvedValue(tokenResponse("ghs_minted", NOW + 3_600_000));
  const minted = await mintInstallationToken(APP, privateKey, { now: () => NOW, fetch: doFetch });

  expect(minted).toEqual({ token: "ghs_minted", expiresAt: NOW + 3_600_000 });
  const [url, init] = doFetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe(`http://mock.test/github/app/installations/${APP.installationId}/access_tokens`);
  expect(init.method).toBe("POST");
  const authorization = String((init.headers as Record<string, string>).authorization);
  expect(authorization).toBe(`Bearer ${mintAppJwt(APP.appId, privateKey, NOW)}`);
});

test("a minted token is reused until five minutes are left, then re-minted", async () => {
  let now = NOW;
  const doFetch = vi
    .fn()
    .mockResolvedValueOnce(tokenResponse("first", NOW + 3_600_000))
    .mockResolvedValueOnce(tokenResponse("second", NOW + 7_200_000));
  const auth = createGithubAuth(APP, {
    now: () => now,
    fetch: doFetch,
    readPrivateKey: () => ({ key: privateKey }),
  });

  expect(await auth.bearer()).toBe("first");
  expect(await auth.bearer()).toBe("first");
  now = NOW + 3_600_000 - 5 * 60_000 - 1;
  expect(await auth.bearer()).toBe("first");
  // Inside the margin: renew while there is still time to fail and retry.
  now += 2;
  expect(await auth.bearer()).toBe("second");
  expect(doFetch).toHaveBeenCalledTimes(2);
});

test("a rejected exchange names the configuration, and never the token", async () => {
  const doFetch = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
  const failure: unknown = await mintInstallationToken(APP, privateKey, {
    now: () => NOW,
    fetch: doFetch,
  }).catch((err: unknown) => err);

  expect(failure).toMatchObject({
    message: expect.stringContaining(String(APP.appId)),
    hint: expect.stringContaining("privateKeyPath"),
  });
});

test("no minted token ever reaches a log line or an error message", async () => {
  const logged: unknown[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args) => logged.push(...args));
  const auth = createGithubAuth(APP, {
    now: () => NOW,
    fetch: vi.fn().mockResolvedValue(tokenResponse("ghs_secret_value", NOW + 3_600_000)),
    readPrivateKey: () => ({ key: privateKey }),
  });
  expect(await auth.bearer()).toBe("ghs_secret_value");
  expect(JSON.stringify(logged)).not.toContain("ghs_secret_value");
  log.mockRestore();
});

test("pat mode is the environment's token, and says so when there is none", async () => {
  const auth = createGithubAuth({ mode: "pat" }, { patToken: () => "ghp_from_env" });
  expect(await auth.bearer()).toBe("ghp_from_env");
  const empty = createGithubAuth({ mode: "pat" }, { patToken: () => "" });
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
  const doFetch = vi.fn().mockResolvedValue(tokenResponse("shared", NOW + 3_600_000));
  const auth = createGithubAuth(APP, {
    now: () => NOW,
    fetch: doFetch,
    readPrivateKey: () => ({ key: privateKey }),
  });
  // What a snapshot does: six reads, none of them waiting for the others.
  const tokens = await Promise.all(Array.from({ length: 6 }, () => auth.bearer()));
  expect(tokens).toEqual(Array(6).fill("shared"));
  expect(doFetch).toHaveBeenCalledTimes(1);
});

test("a failed mint is not cached, so the next caller tries again", async () => {
  const doFetch = vi
    .fn()
    .mockResolvedValueOnce(new Response("nope", { status: 401 }))
    .mockResolvedValueOnce(tokenResponse("second-time", NOW + 3_600_000));
  const auth = createGithubAuth(APP, {
    now: () => NOW,
    fetch: doFetch,
    readPrivateKey: () => ({ key: privateKey }),
  });
  await expect(auth.bearer()).rejects.toThrow();
  expect(await auth.bearer()).toBe("second-time");
});

test("accounts select independent cached installation tokens across Apps", async () => {
  const { githubAuthFor, useFactoryRoot, resetGithubAuth } = await import("./github-auth.ts");
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
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      return tokenResponse(`token-${calls.length}`, Date.now() + 3_600_000);
    }),
  );
  useFactoryRoot(tmp);
  try {
    expect(await githubAuthFor("FIRST").bearer()).toBe("token-1");
    // Existing authentication keeps one config snapshot until explicitly reset.
    writeFileSync(
      path.join(tmp, "jigs.config.ts"),
      'export default { service: { dashboardPort: 9090 }, github: { identity: { mode: "pat" } } }',
    );
    expect(await githubAuthFor("first").bearer()).toBe("token-1");
    expect(await githubAuthFor("Second").bearer()).toBe("token-2");
    expect(await githubAuthFor("Third").bearer()).toBe("token-3");
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("/installations/10/access_tokens");
    expect(calls[1]).toContain("/installations/20/access_tokens");
    expect(() => githubAuthFor("uncovered")).toThrow("account uncovered");
    useFactoryRoot(tmp);
    expect(githubAuthFor("uncovered").identity).toEqual({ mode: "pat" });
  } finally {
    resetGithubAuth();
    vi.unstubAllGlobals();
  }
});
