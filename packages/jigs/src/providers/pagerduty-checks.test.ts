import { expect, test } from "vitest";
import { runChecks } from "../checks/catalog.ts";
import type { PagerDutyIdentity } from "../workflow/factory-schema.ts";
import { ProviderApiError } from "./http.ts";
import {
  type PagerDutyIdentityProbes,
  type PagerDutyUserProbes,
  pagerDutyFromChecks,
  pagerDutyIdentityChecks,
} from "./pagerduty-checks.ts";

const IDENTITY: PagerDutyIdentity = {
  mode: "app",
  subdomain: "acme",
  region: "us",
  from: "oncall@example.com",
};
const ENV = { PAGERDUTY_CLIENT_ID: "id", PAGERDUTY_CLIENT_SECRET: "super-secret" };

function probes(overrides: Partial<PagerDutyIdentityProbes> = {}) {
  const calls: string[] = [];
  const base: PagerDutyIdentityProbes = {
    token: async () => {
      calls.push("token");
    },
    read: async () => {
      calls.push("read");
    },
  };
  return { probes: { ...base, ...overrides }, calls };
}

const outcome = async (
  identity: PagerDutyIdentity,
  env: Record<string, string>,
  p: PagerDutyIdentityProbes,
) => {
  const report = await runChecks(pagerDutyIdentityChecks(identity, p, (name) => env[name]));
  const [found] = report.checks;
  if (found?.id !== "pagerduty.identity") throw new Error("no pagerduty.identity check");
  return found;
};

test("unset client variables fail before any probe runs", async () => {
  const { probes: p, calls } = probes();
  expect(await outcome(IDENTITY, { PAGERDUTY_CLIENT_ID: "id" }, p)).toMatchObject({
    ok: false,
    reason: "PAGERDUTY_CLIENT_SECRET is not set",
    repair: expect.stringContaining(
      "set PAGERDUTY_CLIENT_ID and PAGERDUTY_CLIENT_SECRET (the PagerDuty scoped OAuth app's client id and secret) in the factory repo's .env",
    ),
  });
  expect(await outcome(IDENTITY, {}, p)).toMatchObject({
    reason: "PAGERDUTY_CLIENT_ID and PAGERDUTY_CLIENT_SECRET are not set",
  });
  expect(calls).toEqual([]);
});

test("a refused token names the .env keys and the account, never the secret", async () => {
  const { probes: p } = probes({
    token: async () => {
      throw new Error("PagerDuty refused a client-credentials token (HTTP 401): invalid_client");
    },
  });
  const result = await outcome(IDENTITY, ENV, p);
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("invalid_client"),
    repair: expect.stringContaining("PAGERDUTY_CLIENT_ID and PAGERDUTY_CLIENT_SECRET"),
  });
  expect(result).toMatchObject({ repair: expect.stringContaining("(now acme (us))") });
  expect(result).not.toMatchObject({ repair: expect.stringMatching(/\bscopes?\b/) });
  expect(JSON.stringify(result)).not.toContain("super-secret");
});

test("a read the token may not make names the missing scope", async () => {
  const { probes: p, calls } = probes({
    read: async () => {
      throw new ProviderApiError({
        provider: "pagerduty",
        status: 403,
        request: "GET /incidents",
        body: '{"error":{"message":"Forbidden"}}',
      });
    },
  });
  expect(await outcome(IDENTITY, ENV, p)).toMatchObject({
    ok: false,
    reason: expect.stringContaining("PagerDuty API 403"),
    repair: expect.stringContaining("grant incidents.read"),
  });
  expect(calls).toEqual(["token"]);
});

test("a token that mints and reads is green and names the account", async () => {
  const { probes: p, calls } = probes();
  expect(await outcome(IDENTITY, ENV, p)).toEqual({
    id: "pagerduty.identity",
    label: "PagerDuty identity",
    ok: true,
    detail: "acting as the app on acme (us)",
  });
  expect(calls).toEqual(["token", "read"]);
});

const userProbes = (
  found: PagerDutyUserProbes["userByEmail"] = async () => ({
    id: "PUSER01",
    name: "On Call",
    email: "oncall@example.com",
  }),
  token: PagerDutyUserProbes["token"] = async () => {},
): PagerDutyUserProbes => ({ token, userByEmail: found });

test("a from email that belongs to a user passes and names them", async () => {
  expect((await runChecks(pagerDutyFromChecks(IDENTITY, userProbes()))).checks).toEqual([
    {
      id: "pagerduty.from",
      label: "PagerDuty from user",
      ok: true,
      detail: "notes are attributed to On Call",
    },
  ]);
});

test("a from email no user has fails with a repair naming the setting", async () => {
  const [result] = (
    await runChecks(
      pagerDutyFromChecks(
        IDENTITY,
        userProbes(async () => null),
      ),
    )
  ).checks;
  expect(result).toMatchObject({
    ok: false,
    reason: "no PagerDuty user has the email oncall@example.com",
    repair: expect.stringContaining("set pagerduty.identity.from in jigs.config.ts"),
  });
});

test("a user lookup the token may not make names users.read", async () => {
  const [result] = (
    await runChecks(
      pagerDutyFromChecks(
        IDENTITY,
        userProbes(async () => {
          throw new ProviderApiError({
            provider: "pagerduty",
            status: 403,
            request: "GET /users",
            body: "{}",
          });
        }),
      ),
    )
  ).checks;
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("could not look up oncall@example.com"),
    repair: expect.stringContaining("grant users.read"),
  });
});

test("a lookup PagerDuty did not answer says to retry", async () => {
  for (const err of [
    new ProviderApiError({
      provider: "pagerduty",
      status: 429,
      request: "GET /users",
      body: "{}",
      detail: "rate limited for 600s",
    }),
    new ProviderApiError({
      provider: "pagerduty",
      status: 503,
      request: "GET /users",
      body: "unavailable",
    }),
    new TypeError("fetch failed"),
  ]) {
    const [result] = (
      await runChecks(
        pagerDutyFromChecks(
          IDENTITY,
          userProbes(async () => {
            throw err;
          }),
        ),
      )
    ).checks;
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("could not look up oncall@example.com"),
      repair: expect.stringContaining("PagerDuty did not answer: retry"),
    });
  }
});

test("the from user is not checked while the identity has no token", async () => {
  let looked = false;
  const [result] = (
    await runChecks(
      pagerDutyFromChecks(
        IDENTITY,
        userProbes(
          async () => {
            looked = true;
            return null;
          },
          async () => {
            throw new Error("PagerDuty refused a client-credentials token (HTTP 401)");
          },
        ),
      ),
    )
  ).checks;
  expect(result).toEqual({
    id: "pagerduty.from",
    label: "PagerDuty from user",
    ok: true,
    detail: "not checked: the PagerDuty identity check failed",
  });
  expect(looked).toBe(false);
});
