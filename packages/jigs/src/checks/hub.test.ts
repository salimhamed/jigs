import type { FactoryStatus } from "@jigs-ai/hub-protocol";
import { expect, test } from "vitest";
import { JigsError } from "../errors.ts";
import type { CheckResult } from "./check.ts";
import { installationsCheck } from "./hub.ts";

const status =
  (installations: Array<{ provider: "slack" | "github"; installationName: string | null }>) =>
  async (): Promise<FactoryStatus> => ({
    factory: { name: "f" },
    organization: { name: "o" },
    apps: installations.map(({ provider, installationName }) => ({
      provider,
      name: "jigs",
      installations: [{ account: "Acme", installationName }],
    })),
  });

const probed: string[] = [];
const probe = async (installationName: string): Promise<CheckResult> => {
  probed.push(installationName);
  return installationName.startsWith("bad")
    ? { ok: false, reason: "no token", repair: `name ${installationName}` }
    : { ok: true, detail: "acting as jigs" };
};

const run = (options: Partial<Parameters<typeof installationsCheck>[1]>) => {
  probed.length = 0;
  return installationsCheck("slack", { declared: [], probe, ...options }).run();
};

test("every declared and every named assigned installation is probed once", async () => {
  expect(
    await run({
      declared: ["acme", "acme"],
      status: status([
        { provider: "slack", installationName: "acme" },
        { provider: "slack", installationName: "beta" },
        { provider: "slack", installationName: null },
        { provider: "github", installationName: "gh" },
      ]),
    }),
  ).toEqual({ ok: true, detail: "acme: acting as jigs; beta: acting as jigs" });
  expect(probed).toEqual(["acme", "beta"]);
});

test("a failing installation is named with its own reason and repair", async () => {
  expect(await run({ declared: ["acme", "bad-one", "bad-two"] })).toEqual({
    ok: false,
    reason: "bad-one: no token; bad-two: no token",
    repair: "name bad-one\nname bad-two",
  });
});

test("no named installation fails with the repair on the hub", async () => {
  expect(await run({ status: status([{ provider: "slack", installationName: null }]) })).toEqual({
    ok: false,
    reason: "no Slack installation is named and assigned to this factory on the hub",
    repair: expect.stringContaining("in the hub, name an installation of a Slack app"),
  });
});

test("a hub that cannot answer fails with its own repair", async () => {
  expect(
    await run({
      status: async () => {
        throw new JigsError("this copy has no hub connection", "connect the factory");
      },
    }),
  ).toEqual({
    ok: false,
    reason:
      "could not read this factory's Slack installations from the hub: this copy has no hub connection",
    repair: "connect the factory",
  });
});
