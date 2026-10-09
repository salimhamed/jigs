import { afterEach, expect, test, vi } from "vitest";
import { testFactoryContext } from "../test-fixtures.ts";
import * as hub from "./hub.ts";
import { installationTokens } from "./installation-tokens.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

test("tokens are cached per provider and installation name", async () => {
  const asked = vi.spyOn(hub, "hubToken").mockImplementation((async (
    provider: string,
    installationName: string,
  ) => ({
    token: `${provider}-${installationName}`,
  })) as typeof hub.hubToken);
  const ctx = testFactoryContext();
  expect(await installationTokens("slack", "acme", ctx).bearer()).toBe("slack-acme");
  expect(await installationTokens("slack", "acme", ctx).bearer()).toBe("slack-acme");
  expect(await installationTokens("slack", "other", ctx).bearer()).toBe("slack-other");
  expect(await installationTokens("pagerduty", "acme", ctx).bearer()).toBe("pagerduty-acme");
  expect(asked.mock.calls).toEqual([
    ["slack", "acme", ctx],
    ["slack", "other", ctx],
    ["pagerduty", "acme", ctx],
  ]);
});
