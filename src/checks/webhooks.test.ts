import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WEBHOOK_EVENTS } from "../providers/github-webhook.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { webhookChecks } from "./webhooks.ts";

const fetchMock = vi.fn();
let tmp: string;
let factory: string;

beforeEach(() => {
  tmp = makeTmpDir();
  factory = makeFactoryRepo(tmp);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GITHUB_API_URL", "http://mock.test/github");
  vi.stubEnv("GITHUB_TOKEN", "gh_test_token");
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

function configure(ingress = "https://factory.example.ts.net"): void {
  writeFileSync(
    path.join(factory, "jigs.config.ts"),
    `export default ${JSON.stringify({ ingressUrl: ingress, service: { dashboardPort: 9090 }, workflows: {}, bindings: { api: { remote: "git@github.com:acme/api.git" } } })};`,
  );
}

const checks = () => webhookChecks({ factoryRoot: () => factory });
const check = () => {
  const [found] = checks();
  if (found === undefined) throw new Error("expected a webhook check");
  return found;
};
const hook = (overrides: Record<string, unknown> = {}) => ({
  id: 9,
  active: true,
  events: WEBHOOK_EVENTS,
  config: { url: "https://factory.example.ts.net/ingress/github" },
  ...overrides,
});

test("an active exact-url hook with current events passes", async () => {
  configure();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([hook()])));
  expect(checks().map((check) => check.label)).toEqual(["webhook api"]);
  expect(await check().run()).toEqual({ ok: true });
});

test("a valid exact-url hook passes after a stale duplicate", async () => {
  configure();
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify([hook({ id: 8, active: false }), hook({ id: 9, active: true })])),
  );
  expect(await check().run()).toEqual({ ok: true });
});

test("a missing hook fails with the exact bind repair", async () => {
  configure();
  fetchMock.mockResolvedValueOnce(new Response("[]"));
  expect(await check().run()).toEqual({
    ok: false,
    reason: "the repo has no active webhook at this factory's ingress URL with the current events",
    repair: "run: jigs bind git@github.com:acme/api.git",
  });
});

test.each([
  ["inactive", { active: false }],
  ["wrong events", { events: ["pull_request"] }],
])("a hook with %s fails", async (_label, overrides) => {
  configure();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([hook(overrides)])));
  expect(await check().run()).toMatchObject({ ok: false });
});

test("a refused hooks API names the required token scope", async () => {
  configure();
  fetchMock.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
  const result = await check().run();
  expect(result).toMatchObject({ ok: false });
  expect(result.ok === false && result.repair).toContain("admin:repo_hook");
});

test("an App that cannot read a repo's hooks names installation access", async () => {
  configure();
  fetchMock.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
  const [appCheck] = webhookChecks({
    factoryRoot: () => factory,
    identity: () => ({
      mode: "app",
      appId: 4958325,
      installationId: 162033982,
      privateKeyPath: "github-app.private-key.pem",
      operator: "salimhamed",
    }),
  });
  if (appCheck === undefined) throw new Error("expected a webhook check");
  const result = await appCheck.run();
  expect(result).toMatchObject({ ok: false });
  expect(result.ok === false && result.repair).toContain("install the App on acme/api");
});

test("an installed App missing hook permission gets the permission repair", async () => {
  configure();
  fetchMock.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
  const [appCheck] = webhookChecks({
    factoryRoot: () => factory,
    identity: () => ({
      mode: "app",
      appId: 4958325,
      installationId: 162033982,
      privateKeyPath: "github-app.private-key.pem",
      operator: "salimhamed",
    }),
  });
  if (appCheck === undefined) throw new Error("expected a webhook check");
  const result = await appCheck.run();
  expect(result).toMatchObject({ ok: false });
  if (result.ok !== false) throw new Error("expected failure");
  expect(result.repair).toMatch(/^grant the App "Repository webhooks: read & write"/);
  expect(result.repair).not.toContain("install the App");
});

test("no ingressUrl emits no webhook checks", () => {
  expect(checks()).toEqual([]);
});
