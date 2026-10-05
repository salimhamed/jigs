import { expect, test } from "vitest";
import { testFactoryContext } from "../test-fixtures.ts";
import { runChecks } from "./catalog.ts";
import { hubSlackChecks } from "./hub.ts";

const status =
  (apps: Array<{ provider: string; name: string; accounts: string[] }>) => async () => ({
    factory: { name: "f" },
    organization: { name: "o" },
    apps: apps.map(({ provider, name, accounts }) => ({
      provider: provider as "slack",
      name,
      installations: accounts.map((account) => ({ account })),
    })),
  });

const outcome = async (apps: Parameters<typeof status>[0]) =>
  (await runChecks(hubSlackChecks(testFactoryContext(), status(apps)))).checks[0];

test("an assigned Slack app passes, naming its workspaces", async () => {
  expect(await outcome([{ provider: "slack", name: "jigs", accounts: ["Acme"] }])).toEqual({
    id: "hub.slack",
    label: "hub Slack app",
    ok: true,
    detail: "jigs in Acme",
  });
});

test("no Slack app assigned fails with the repair", async () => {
  expect(await outcome([{ provider: "github", name: "jigs", accounts: ["acme"] }])).toMatchObject({
    ok: false,
    reason: "no Slack app is assigned to this factory on the hub",
    repair: expect.stringContaining("assign this factory a Slack app"),
  });
});
