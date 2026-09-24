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

function configure(github = true): void {
  const webhooks = {
    url: "https://factory.example.ts.net",
    github: { enabled: github },
    linear: { enabled: false },
  };
  writeFileSync(
    path.join(factory, "jigs.config.ts"),
    `export default ${JSON.stringify({ webhooks, service: { dashboardPort: 9090 }, workflows: {}, bindings: { api: { remote: "git@github.com:acme/api.git" } } })};`,
  );
}

const checks = () => webhookChecks({ factoryRoot: () => factory });
const check = () => {
  const [, found] = checks();
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

const delivery = (status_code: number, delivered_at: string) => ({
  id: 1,
  status_code,
  delivered_at,
});
const respond = (hooks: unknown[], deliveries: unknown[] = []) =>
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify(hooks)))
    .mockResolvedValueOnce(new Response(JSON.stringify(deliveries)));

test("an active exact-url hook with current events and no deliveries passes", async () => {
  configure();
  respond([hook()]);
  expect(checks().map((check) => check.label)).toEqual(["GitHub webhook secret", "webhook api"]);
  expect(await check().run()).toEqual({ ok: true });
  const [deliveriesUrl] = fetchMock.mock.calls[1] as [string];
  expect(deliveriesUrl).toBe(
    "http://mock.test/github/repos/acme/api/hooks/9/deliveries?per_page=10",
  );
});

test("a hook whose latest delivery was accepted passes despite older 401s", async () => {
  configure();
  respond([hook()], [delivery(401, "2026-09-23T10:00:00Z"), delivery(200, "2026-09-23T11:00:00Z")]);
  expect(await check().run()).toEqual({ ok: true });
});

test("recent 401 deliveries fail with the bind repair that re-sends the secret", async () => {
  configure();
  respond(
    [hook()],
    [
      delivery(401, "2026-09-23T11:00:00Z"),
      delivery(200, "2026-09-23T09:00:00Z"),
      delivery(401, "2026-09-23T12:00:00Z"),
    ],
  );
  expect(await check().run()).toEqual({
    ok: false,
    reason:
      "the factory rejected the hook's latest 2 deliveries with 401: GitHub's copy of the signing secret does not match GITHUB_WEBHOOK_SECRET in this factory's .env",
    repair: "run: pnpm exec jigs bind git@github.com:acme/api.git",
  });
});

const secretCheck = () => {
  const [found] = checks();
  if (found === undefined) throw new Error("expected the secret check");
  return found;
};

test.each([
  ["unset", undefined],
  ["empty", ""],
])("an %s GITHUB_WEBHOOK_SECRET fails the secret check", async (_label, value) => {
  configure();
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
  if (value !== undefined)
    writeFileSync(path.join(factory, ".env"), `GITHUB_WEBHOOK_SECRET=${value}\n`);
  expect(await secretCheck().run()).toEqual({
    ok: false,
    reason: `webhooks.github is enabled but GITHUB_WEBHOOK_SECRET is not set in ${path.join(factory, ".env")}`,
    repair: `generate one with \`openssl rand -hex 32\`, set it as GITHUB_WEBHOOK_SECRET in ${path.join(factory, ".env")} and restart the service (pnpm exec jigs service restart), then run pnpm exec jigs bind for each bound repo`,
  });
});

test("a GITHUB_WEBHOOK_SECRET in the factory's .env passes the secret check", async () => {
  configure();
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
  writeFileSync(path.join(factory, ".env"), "GITHUB_WEBHOOK_SECRET=s3cret\n");
  expect(await secretCheck().run()).toEqual({ ok: true });
});

test("a passing webhook check does not resolve the GitHub identity", async () => {
  configure();
  respond([hook()]);
  const identity = vi.fn();
  const [, found] = webhookChecks({ factoryRoot: () => factory, identity });
  if (found === undefined) throw new Error("expected a webhook check");
  expect(await found.run()).toEqual({ ok: true });
  expect(identity).not.toHaveBeenCalled();
});

test("a valid exact-url hook passes after a stale duplicate", async () => {
  configure();
  respond([hook({ id: 8, active: false }), hook({ id: 9, active: true })]);
  expect(await check().run()).toEqual({ ok: true });
  const [deliveriesUrl] = fetchMock.mock.calls[1] as [string];
  expect(deliveriesUrl).toContain("/hooks/9/deliveries");
});

test("a missing hook fails with the exact bind repair", async () => {
  configure();
  fetchMock.mockResolvedValueOnce(new Response("[]"));
  expect(await check().run()).toEqual({
    ok: false,
    reason: "the repo has no active webhook at this factory's webhooks.url with the current events",
    repair: "run: pnpm exec jigs bind git@github.com:acme/api.git",
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
  const [, appCheck] = webhookChecks({
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
  const [, appCheck] = webhookChecks({
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

test("no webhooks block emits no webhook checks", () => {
  expect(checks()).toEqual([]);
});

test("GitHub switched off emits no webhook checks, even without its secret", () => {
  configure(false);
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
  expect(checks()).toEqual([]);
});
