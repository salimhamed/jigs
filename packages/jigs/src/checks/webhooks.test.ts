import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WEBHOOK_EVENTS } from "../github-webhook.ts";
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
    path.join(factory, "jigs.yml"),
    `ingress_url: ${ingress}\nservice:\n  dashboard_port: 9090\nbindings:\n  api:\n    remote: git@github.com:acme/api.git\n`,
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
    new Response(
      JSON.stringify([
        hook({ id: 8, active: false }),
        hook({ id: 9, active: true }),
      ]),
    ),
  );
  expect(await check().run()).toEqual({ ok: true });
});

test("a missing hook fails with the exact bind repair", async () => {
  configure();
  fetchMock.mockResolvedValueOnce(new Response("[]"));
  expect(await check().run()).toEqual({
    ok: false,
    reason:
      "the repo has no active webhook at this factory's ingress URL with the current events",
    repair: "run: jigs bind git@github.com:acme/api.git",
  });
});

test.each([
  ["inactive", { active: false }],
  ["wrong events", { events: ["pull_request"] }],
])("a hook with %s fails", async (_label, overrides) => {
  configure();
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify([hook(overrides)])),
  );
  expect(await check().run()).toMatchObject({ ok: false });
});

test("a refused hooks API names the required token scope", async () => {
  configure();
  fetchMock.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
  const result = await check().run();
  expect(result).toMatchObject({ ok: false });
  expect(result.ok === false && result.repair).toContain("admin:repo_hook");
});

test("no ingress_url emits no webhook checks", () => {
  expect(checks()).toEqual([]);
});
