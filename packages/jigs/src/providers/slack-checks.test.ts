import { slackBotScopes } from "@jigs-ai/hub-protocol";
import { expect, test } from "vitest";
import { testFactoryContext } from "../test-fixtures.ts";
import { HubResponseError } from "./hub.ts";
import { slackInstallationProbe } from "./slack-checks.ts";

const issued = (scopes: readonly string[]) => async () => ({
  token: "xoxb-test",
  expiresAt: "2999-01-01T00:00:00Z",
  app: { appId: "A0TEST", name: "jigs", botUserId: "U0TEST" },
  team: "T0TEST",
  scopes: [...scopes],
});

const probe = (issue: Parameters<typeof slackInstallationProbe>[1]) =>
  slackInstallationProbe(testFactoryContext(), issue)("acme");

test("a token holding every scope jigs uses passes, naming the app and workspace", async () => {
  expect(await probe(issued(slackBotScopes))).toEqual({
    ok: true,
    detail: "acting as jigs in T0TEST",
  });
});

test("a scope the workspace did not grant fails, naming it and where to add it", async () => {
  expect(await probe(issued(slackBotScopes.filter((s) => s !== "users:read")))).toMatchObject({
    ok: false,
    reason: "jigs's bot token lacks users:read",
    repair: expect.stringContaining("in the hub, add users:read to jigs's bot scopes"),
  });
});

test("no token from the hub fails with the hub's reason and repair", async () => {
  expect(
    await probe(async () => {
      throw new HubResponseError(404, "the hub answered 404", "in the hub, install it");
    }),
  ).toEqual({
    ok: false,
    reason: "the hub gave no Slack token: the hub answered 404",
    repair: "in the hub, install it",
  });
});
