import { expect, test } from "vitest";
import { testFactoryContext } from "../test-fixtures.ts";
import { githubInstallationProbe } from "./github-checks.ts";
import { HubResponseError } from "./hub.ts";

const ctx = testFactoryContext();

test("an installation the hub hands a token for passes, naming the bot and the account", async () => {
  const probe = githubInstallationProbe(ctx, async (installationName) => ({
    token: "t",
    expiresAt: "2999-01-01T00:00:00Z",
    account: installationName === "acme" ? "Acme" : "other",
    app: { slug: "jigs-dev", botUserId: 1 },
  }));
  expect(await probe("acme")).toEqual({ ok: true, detail: "jigs-dev[bot] on Acme" });
});

test("an installation the hub does not give the factory fails with the hub's repair", async () => {
  const probe = githubInstallationProbe(ctx, async () => {
    throw new HubResponseError(404, "the hub answered 404", "in the hub, name it");
  });
  expect(await probe("acme")).toEqual({
    ok: false,
    reason: "the hub gave no GitHub token: the hub answered 404",
    repair: "in the hub, name it",
  });
});
