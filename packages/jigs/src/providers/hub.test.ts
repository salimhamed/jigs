import { afterEach, expect, test, vi } from "vitest";
import { testFactoryContext } from "../test-fixtures.ts";
import { JIGS_VERSION } from "../version.ts";
import { fetchFactoryStatus, fetchGithubToken, fetchLinearToken, fetchSlackToken } from "./hub.ts";
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

test("a GitHub token is asked for by owner, with the factory token and jigs' version", async () => {
  const issued = {
    token: "ghs_1",
    expiresAt: "2026-10-04T13:00:00Z",
    app: { slug: "a", botUserId: 1 },
  };
  const { calls } = hubAnswering(jsonResponse(issued));
  await expect(fetchGithubToken("acme", ctx())).resolves.toEqual(issued);
  expect(calls).toEqual([
    expect.objectContaining({
      method: "POST",
      url: new URL("https://hub.example.test/api/factory/tokens/github"),
      json: { owner: "acme" },
      headers: expect.objectContaining({
        authorization: "Bearer factory-token",
        "user-agent": `jigs/${JIGS_VERSION}`,
      }),
    }),
  ]);
});

test("an owner no assigned App is installed on carries the hub's reason and the repair", async () => {
  hubAnswering(
    jsonResponse({ error: "No GitHub App assigned to this factory is installed on acme." }, 404),
  );
  await expect(fetchGithubToken("acme", ctx())).rejects.toMatchObject({
    status: 404,
    message: expect.stringContaining(
      "No GitHub App assigned to this factory is installed on acme.",
    ),
    hint: expect.stringContaining("install one of this factory's GitHub Apps on acme"),
  });
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

test("a Linear token names the workspace only when the factory knows it", async () => {
  const issued = {
    token: "lin_1",
    expiresAt: "2026-10-05T12:00:00Z",
    app: { name: "jigs", userId: "app-user" },
  };
  const { calls } = hubAnswering(jsonResponse(issued));
  await expect(fetchLinearToken(undefined, ctx())).resolves.toEqual(issued);
  const named = hubAnswering(jsonResponse(issued));
  await fetchLinearToken("acme", ctx());
  expect(calls[0]).toMatchObject({
    method: "POST",
    url: new URL("https://hub.example.test/api/factory/tokens/linear"),
    json: {},
  });
  expect(named.calls[0]).toMatchObject({ json: { organization: "acme" } });
});

test("a Linear workspace that needs reconnecting says so with the repair", async () => {
  hubAnswering(
    jsonResponse({ error: "Connect acme to jigs again on the hub: invalid_grant" }, 503),
  );
  await expect(fetchLinearToken(undefined, ctx())).rejects.toMatchObject({
    status: 503,
    message: expect.stringContaining("Connect acme to jigs again on the hub"),
    hint: expect.stringContaining("connect the Linear workspace again"),
  });
});

test("a Slack token is asked for with an empty body", async () => {
  const issued = {
    token: "xoxb-1",
    scopes: ["chat:write"],
    app: { appId: "A1", name: "jigs", botUserId: "U1" },
    team: "T1",
  };
  const { calls } = hubAnswering(jsonResponse(issued));
  await expect(fetchSlackToken(ctx())).resolves.toEqual(issued);
  expect(calls[0]).toMatchObject({
    method: "POST",
    url: new URL("https://hub.example.test/api/factory/tokens/slack"),
    json: {},
  });
});

test("no Slack installation for the factory says so with the repair", async () => {
  hubAnswering(jsonResponse({ error: "No Slack app assigned to this factory." }, 404));
  await expect(fetchSlackToken(ctx())).rejects.toMatchObject({
    status: 404,
    hint: expect.stringContaining("in the hub, install one of this factory's Slack apps"),
  });
});
