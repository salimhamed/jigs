import type { FactoryStatus } from "@jigs-ai/hub-protocol";
import { expect, test } from "vitest";
import { JigsError } from "../errors.ts";
import { testFactoryContext } from "../test-fixtures.ts";
import { githubChecks } from "./github-checks.ts";

const ctx = testFactoryContext({
  config: {
    bindings: {
      api: { remote: "git@github.com:acme/api.git" },
      web: { remote: "https://github.com/Widgets/web.git" },
      local: { remote: "file:///srv/git/repo.git" },
    },
  },
});

const app = (name: string, ...accounts: string[]): FactoryStatus["apps"][number] => ({
  provider: "github",
  name,
  installations: accounts.map((account) => ({ account })),
});

const status = (apps: FactoryStatus["apps"]) => async (): Promise<FactoryStatus> => ({
  factory: { name: "personal" },
  organization: { name: "Acme" },
  apps,
});

const run = async (read: () => Promise<FactoryStatus>) => {
  const [check] = githubChecks(ctx, read);
  return check?.run();
};

test("an App installed on every bound owner passes and says where it acts", async () => {
  expect(await run(status([app("jigs-dev", "acme", "widgets")]))).toEqual({
    ok: true,
    detail: "jigs-dev on acme, widgets",
  });
});

test("no GitHub App assigned fails, whatever else is assigned", async () => {
  expect(
    await run(status([{ provider: "linear", name: "jigs", installations: [{ account: "acme" }] }])),
  ).toMatchObject({ ok: false, reason: "no GitHub App is assigned to this factory on the hub" });
});

test("a bound owner no App is installed on is named", async () => {
  expect(await run(status([app("jigs-dev", "acme")]))).toMatchObject({
    ok: false,
    reason: "no GitHub App assigned to this factory is installed on Widgets",
  });
});

test("an owner with two of the factory's Apps installed is named, since the hub refuses its tokens", async () => {
  expect(await run(status([app("one", "acme", "widgets"), app("two", "acme")]))).toMatchObject({
    ok: false,
    reason: "acme has more than one of this factory's GitHub Apps installed (one, two)",
  });
});

test("a hub that cannot answer fails with its own repair", async () => {
  expect(
    await run(async () => {
      throw new JigsError("JIGS_HUB_TOKEN is not set", "connect the factory");
    }),
  ).toEqual({
    ok: false,
    reason: "could not read this factory's GitHub Apps from the hub: JIGS_HUB_TOKEN is not set",
    repair: "connect the factory",
  });
});
