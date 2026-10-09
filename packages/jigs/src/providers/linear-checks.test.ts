import { expect, test } from "vitest";
import { testFactoryContext } from "../test-fixtures.ts";
import { HubResponseError } from "./hub.ts";
import { type LinearInstallationProbeDeps, linearInstallationProbe } from "./linear-checks.ts";

const issue = async () => ({
  token: "t",
  expiresAt: "2999-01-01T00:00:00Z",
  app: { name: "jigs", userId: "app-user" },
});

const probe = (deps: LinearInstallationProbeDeps) =>
  linearInstallationProbe(testFactoryContext(), { issue, ...deps })("acme");

const users =
  (found: Record<string, { id: string; name: string }>) =>
  async (installationName: string, email: string) =>
    installationName === "acme" ? (found[email] ?? null) : null;

test("an installation the hub hands a token for passes, naming the app", async () => {
  expect(await probe({})).toEqual({ ok: true, detail: "acting as jigs" });
});

test("a workspace that needs reconnecting fails with the hub's reason and the repair", async () => {
  expect(
    await probe({
      issue: async () => {
        throw new HubResponseError(
          503,
          "the hub answered 503: Connect acme to jigs again on the hub",
          "in the hub, connect the Linear workspace again",
        );
      },
    }),
  ).toMatchObject({
    ok: false,
    reason: expect.stringContaining("Connect acme to jigs again"),
    repair: "in the hub, connect the Linear workspace again",
  });
});

test("an operator email no Linear user in the installation has fails with a repair naming the setting", async () => {
  expect(await probe({ operator: "typo@example.com", userByEmail: users({}) })).toEqual({
    ok: false,
    reason: "no active Linear user has the email typo@example.com",
    repair: expect.stringContaining("set linear.operator in jigs.config.ts"),
  });
});

test("a found operator passes and names who is mentioned", async () => {
  expect(
    await probe({
      operator: "salim@example.com",
      userByEmail: users({ "salim@example.com": { id: "u2", name: "Salim" } }),
    }),
  ).toEqual({ ok: true, detail: "acting as jigs, mentions Salim" });
});
