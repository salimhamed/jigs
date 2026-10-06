import { slackBotScopes } from "@jigs-ai/hub-protocol";
import { expect, test } from "vitest";
import { runChecks } from "../checks/catalog.ts";
import { testFactoryContext } from "../test-fixtures.ts";
import { HubResponseError } from "./hub.ts";
import { slackChecks } from "./slack-checks.ts";

const issued = (scopes: readonly string[]) => async () => ({
  token: "xoxb-test",
  app: { appId: "A0TEST", name: "jigs", botUserId: "U0TEST" },
  team: "T0TEST",
  scopes: [...scopes],
});

const outcome = async (
  issue: Parameters<typeof slackChecks>[1],
  config: Record<string, unknown> = { slack: {} },
) => (await runChecks(slackChecks(testFactoryContext({ config }), issue))).checks[0];

test("a token holding every scope jigs uses passes, naming the app and workspace", async () => {
  expect(await outcome(issued(slackBotScopes))).toEqual({
    id: "slack.identity",
    label: "Slack app",
    ok: true,
    detail: "acting as jigs in T0TEST",
  });
});

test("a scope the workspace did not grant fails, naming it and where to add it", async () => {
  expect(await outcome(issued(slackBotScopes.filter((s) => s !== "users:read")))).toMatchObject({
    ok: false,
    reason: "jigs's bot token lacks users:read",
    repair: expect.stringContaining("in the hub, add users:read to jigs's bot scopes"),
  });
});

test("the factory's own slack.scopes are checked too", async () => {
  expect(
    await outcome(issued(slackBotScopes), { slack: { scopes: ["pins:write"] } }),
  ).toMatchObject({ ok: false, reason: "jigs's bot token lacks pins:write" });
});

test("no Slack app on the hub fails with the hub's reason and repair", async () => {
  expect(
    await outcome(async () => {
      throw new HubResponseError(404, "the hub answered 404", "in the hub, install it");
    }),
  ).toMatchObject({
    ok: false,
    reason: "the hub has no Slack token for this factory: the hub answered 404",
    repair: "in the hub, install it",
  });
});
