import { expect, test } from "vitest";
import { runChecks } from "../checks/catalog.ts";
import { testFactoryContext } from "../test-fixtures.ts";
import { HubResponseError } from "./hub.ts";
import { linearChecks, linearOperatorChecks } from "./linear-checks.ts";

const ctx = testFactoryContext();

const outcome = async (issue: Parameters<typeof linearChecks>[1]) =>
  (await runChecks(linearChecks(ctx, issue))).checks[0];

test("a Linear app the hub hands a token for passes, naming the app", async () => {
  expect(
    await outcome(async () => ({
      token: "t",
      expiresAt: "2999-01-01T00:00:00Z",
      app: { name: "jigs", userId: "app-user" },
    })),
  ).toEqual({ id: "linear.identity", label: "Linear app", ok: true, detail: "acting as jigs" });
});

test("a workspace that needs reconnecting fails with the hub's reason and the repair", async () => {
  expect(
    await outcome(async () => {
      throw new HubResponseError(
        503,
        "the hub answered 503: Connect acme to jigs again on the hub",
        "in the hub, connect the Linear workspace again",
      );
    }),
  ).toMatchObject({
    ok: false,
    reason: expect.stringContaining("Connect acme to jigs again"),
    repair: "in the hub, connect the Linear workspace again",
  });
});

const userByEmail =
  (users: Record<string, { id: string; name: string }>) => async (email: string) =>
    users[email] ?? null;

test("an operator email no Linear user has fails with a repair naming the setting", async () => {
  expect(
    (await runChecks(linearOperatorChecks("typo@example.com", userByEmail({})))).checks,
  ).toEqual([
    {
      id: "linear.operator",
      label: "Linear operator",
      ok: false,
      reason: "no active Linear user has the email typo@example.com",
      repair: expect.stringContaining("set linear.operator in jigs.config.ts"),
    },
  ]);
});

test("a found operator passes and names who is mentioned", async () => {
  const users = userByEmail({ "salim@example.com": { id: "u2", name: "Salim" } });
  expect((await runChecks(linearOperatorChecks("salim@example.com", users))).checks).toEqual([
    { id: "linear.operator", label: "Linear operator", ok: true, detail: "mentions Salim" },
  ]);
});

test("no operator configured means no operator check", () => {
  expect(linearOperatorChecks(undefined, userByEmail({}))).toEqual([]);
});
