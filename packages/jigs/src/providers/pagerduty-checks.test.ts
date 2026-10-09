import { expect, test } from "vitest";
import { testFactoryContext } from "../test-fixtures.ts";
import { ProviderApiError } from "./http.ts";
import { HubResponseError } from "./hub.ts";
import {
  type PagerDutyInstallationProbeDeps,
  pagerDutyInstallationProbe,
} from "./pagerduty-checks.ts";

function probe(overrides: PagerDutyInstallationProbeDeps = {}) {
  const calls: string[] = [];
  const run = pagerDutyInstallationProbe(testFactoryContext(), {
    token: async (installationName) => {
      calls.push(`token ${installationName}`);
      return { from: "oncall@example.com" };
    },
    read: async (installationName) => {
      calls.push(`read ${installationName}`);
    },
    ...overrides,
  });
  return { result: () => run("acme"), calls };
}

test("no token from the hub carries the hub's reason and repair", async () => {
  const { result, calls } = probe({
    token: async () => {
      throw new HubResponseError(
        503,
        "the hub answered 503 to POST /api/factory/tokens/pagerduty: PagerDuty refused pd's credentials",
        "in the hub, remove the app and add it again",
      );
    },
  });
  expect(await result()).toMatchObject({
    ok: false,
    reason: expect.stringContaining("PagerDuty refused pd's credentials"),
    repair: "in the hub, remove the app and add it again",
  });
  expect(calls).toEqual([]);
});

test("a read the token may not make names the missing scope", async () => {
  const { result, calls } = probe({
    read: async () => {
      throw new ProviderApiError({
        provider: "pagerduty",
        status: 403,
        request: "GET /incidents",
        body: '{"error":{"message":"Forbidden"}}',
      });
    },
  });
  expect(await result()).toMatchObject({
    ok: false,
    reason: expect.stringContaining("PagerDuty API 403"),
    repair: expect.stringContaining("grant the factory's PagerDuty app incidents.read"),
  });
  expect(calls).toEqual(["token acme"]);
});

test("a token that reads incidents passes, naming who notes are made as", async () => {
  const { result, calls } = probe();
  expect(await result()).toEqual({ ok: true, detail: "notes made as oncall@example.com" });
  expect(calls).toEqual(["token acme", "read acme"]);
});
