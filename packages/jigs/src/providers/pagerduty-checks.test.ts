import { expect, test } from "vitest";
import { runChecks } from "../checks/catalog.ts";
import { testFactoryContext } from "../test-fixtures.ts";
import { ProviderApiError } from "./http.ts";
import { HubResponseError } from "./hub.ts";
import {
  type PagerDutyAppProbes,
  type PagerDutyUserProbes,
  pagerDutyAppChecks,
  pagerDutyFromChecks,
} from "./pagerduty-checks.ts";

const FROM = "oncall@example.com";

function probes(overrides: Partial<PagerDutyAppProbes> = {}) {
  const calls: string[] = [];
  const base: PagerDutyAppProbes = {
    token: async () => {
      calls.push("token");
    },
    read: async () => {
      calls.push("read");
    },
  };
  return { probes: { ...base, ...overrides }, calls };
}

const outcome = async (p: PagerDutyAppProbes) => {
  const [found] = (await runChecks(pagerDutyAppChecks(testFactoryContext(), p))).checks;
  if (found?.id !== "pagerduty.app") throw new Error("no pagerduty.app check");
  return found;
};

test("no token from the hub carries the hub's reason and repair", async () => {
  const { probes: p, calls } = probes({
    token: async () => {
      throw new HubResponseError(
        503,
        "the hub answered 503 to POST /api/factory/tokens/pagerduty: PagerDuty refused pd's credentials",
        "in the hub, remove the app and add it again",
      );
    },
  });
  expect(await outcome(p)).toMatchObject({
    ok: false,
    reason: expect.stringContaining("PagerDuty refused pd's credentials"),
    repair: "in the hub, remove the app and add it again",
  });
  expect(calls).toEqual([]);
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
  expect(await outcome(p)).toMatchObject({
    ok: false,
    reason: expect.stringContaining("PagerDuty API 403"),
    repair: expect.stringContaining("grant the factory's PagerDuty app incidents.read"),
  });
  expect(calls).toEqual(["token"]);
});

test("a token that reads incidents is green", async () => {
  const { probes: p, calls } = probes();
  expect(await outcome(p)).toEqual({
    id: "pagerduty.app",
    label: "PagerDuty app",
    ok: true,
    detail: "acting as the hub's PagerDuty app",
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
  expect((await runChecks(pagerDutyFromChecks(FROM, userProbes()))).checks).toEqual([
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
        FROM,
        userProbes(async () => null),
      ),
    )
  ).checks;
  expect(result).toMatchObject({
    ok: false,
    reason: "no PagerDuty user has the email oncall@example.com",
    repair: expect.stringContaining("set pagerduty.from in jigs.config.ts"),
  });
});

test("a user lookup the token may not make names users.read", async () => {
  const [result] = (
    await runChecks(
      pagerDutyFromChecks(
        FROM,
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
    repair: expect.stringContaining("grant the factory's PagerDuty app users.read"),
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
          FROM,
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

test("the from user is not checked while the app has no token", async () => {
  let looked = false;
  const [result] = (
    await runChecks(
      pagerDutyFromChecks(
        FROM,
        userProbes(
          async () => {
            looked = true;
            return null;
          },
          async () => {
            throw new Error("the hub answered 503");
          },
        ),
      ),
    )
  ).checks;
  expect(result).toEqual({
    id: "pagerduty.from",
    label: "PagerDuty from user",
    ok: true,
    detail: "not checked: the PagerDuty app check failed",
  });
  expect(looked).toBe(false);
});
