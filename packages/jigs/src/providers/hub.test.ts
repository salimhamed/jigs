import { afterEach, expect, test, vi } from "vitest";
import { testFactoryContext } from "../test-fixtures.ts";
import { JIGS_VERSION } from "../version.ts";
import { fetchFactoryStatus, hubToken } from "./hub.ts";
import { fakeFetch, jsonResponse } from "./test-support.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ctx = (token: string | null = "factory-token") =>
  testFactoryContext(token === null ? {} : { env: { JIGS_HUB_TOKEN: token } });

function hubAnswering(res: Response) {
  const fake = fakeFetch(() => res);
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

test("a GitHub token is asked for by installation name, with the factory token and jigs' version", async () => {
  const issued = {
    token: "ghs_1",
    expiresAt: "2026-10-04T13:00:00Z",
    account: "acme",
    app: { slug: "a", botUserId: 1 },
  };
  const { calls } = hubAnswering(jsonResponse(issued));
  await expect(hubToken("github", "acme-github", ctx())).resolves.toEqual(issued);
  expect(calls).toEqual([
    expect.objectContaining({
      method: "POST",
      url: new URL("https://hub.example.test/api/factory/tokens/github"),
      json: { installationName: "acme-github" },
      headers: expect.objectContaining({
        authorization: "Bearer factory-token",
        "user-agent": `jigs/${JIGS_VERSION}`,
      }),
    }),
  ]);
});

test("an installation name the hub does not know carries the hub's reason and the repair", async () => {
  hubAnswering(jsonResponse({ error: "No installation named acme-linear." }, 404));
  await expect(hubToken("linear", "acme-linear", ctx())).rejects.toMatchObject({
    status: 404,
    message: expect.stringContaining("No installation named acme-linear."),
    hint: expect.stringContaining("name a Linear installation acme-linear"),
  });
});

test("a hub failure other than an unknown installation carries no hint", async () => {
  hubAnswering(jsonResponse({ error: "PagerDuty refused pd's credentials for acme (401)." }, 503));
  const error = await hubToken("pagerduty", "acme-pd", ctx()).catch((e: unknown) => e);
  expect(error).toMatchObject({
    status: 503,
    message: expect.stringContaining("PagerDuty refused pd's credentials for acme"),
  });
  expect((error as { hint?: string }).hint).toBeUndefined();
});
test("a rejected factory token says how to connect again", async () => {
  hubAnswering(new Response("", { status: 401 }));
  await expect(fetchFactoryStatus(ctx())).rejects.toMatchObject({
    status: 401,
    message: "the hub at https://hub.example.test rejected JIGS_HUB_TOKEN",
    hint: expect.stringContaining("jigs hub connect"),
  });
});

test("no request is made without a factory token", async () => {
  const { calls } = hubAnswering(jsonResponse({}));
  await expect(fetchFactoryStatus(ctx(null))).rejects.toThrow("JIGS_HUB_TOKEN is not set");
  expect(calls).toEqual([]);
});

test.each(["linear", "slack", "pagerduty"] as const)(
  "a %s token is asked for by installation name",
  async (provider) => {
    const { calls } = hubAnswering(jsonResponse({ token: "t" }));
    await hubToken(provider, "acme", ctx());
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: new URL(`https://hub.example.test/api/factory/tokens/${provider}`),
      json: { installationName: "acme" },
    });
  },
);
