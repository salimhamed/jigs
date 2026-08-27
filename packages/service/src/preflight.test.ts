import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
// Real git fixtures, reached by path: they are test-only, so they stay out
// of the jigs package's export map.
import {
  makeFactoryRepo,
  makeRemoteBackedRepo,
  makeTmpDir,
  removeTmpDir,
} from "../../jigs/src/test-fixtures.ts";

// File-scoped so it cannot disturb app.test.ts: the whole point of AC1 is
// that a refused trigger never reaches start().
const { start } = vi.hoisted(() => ({
  start: vi.fn(async () => ({ runId: "wr_started" })),
}));
vi.mock("workflow/api", () => ({
  start,
  getRun: () => ({ exists: Promise.resolve(false) }),
  getHookByToken: async () => ({ metadata: null }),
  resumeHook: async () => ({}),
}));

const { default: app } = await import("./app");

let tmp: string;
let claudeStub: string;

const SUBSCRIPTION_STATUS = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  subscriptionType: "team",
});

beforeAll(() => {
  tmp = makeTmpDir();
  // A real executable answering the real flags, so the harness check runs
  // its actual code path without depending on this machine's login.
  claudeStub = path.join(tmp, "claude-stub");
  writeFileSync(claudeStub, `#!/bin/sh\necho '${SUBSCRIPTION_STATUS}'\n`);
  chmodSync(claudeStub, 0o755);
});
afterAll(() => {
  removeTmpDir(tmp);
});

beforeEach(() => {
  start.mockClear();
  vi.unstubAllEnvs();
  vi.stubEnv("WORKFLOW_LOCAL_DATA_DIR", tmp);
  vi.stubEnv("JIGS_CLAUDE_EXECUTABLE", claudeStub);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function seedThreeFailures(): void {
  vi.stubEnv("LINEAR_API_KEY", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubEnv(
    "JIGS_FACTORY_ROOT",
    makeFactoryRepo(makeTmpDir(), "bindings: {}\n"),
  );
}

const trigger = () =>
  app.request("/api/pipelines/preflight-demo/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs: {} }),
  });

interface Failure {
  id: string;
  label: string;
  reason: string;
  repair: string;
}

test("a trigger with three seeded failures is refused with all three at once", async () => {
  seedThreeFailures();
  const res = await trigger();
  expect(res.status).toBe(424);

  const body = (await res.json()) as {
    error: string;
    failures: Failure[];
    runId?: string;
  };
  expect(body.error).toBe("preflight failed");
  expect(body.failures.map((failure) => failure.id).sort()).toEqual([
    "binding.api",
    "core.github-token",
    "core.linear-api-key",
  ]);
  for (const failure of body.failures) {
    expect(failure.reason).not.toBe("");
    expect(failure.repair).not.toBe("");
  }
  expect(body.runId).toBeUndefined();
  expect(start).not.toHaveBeenCalled();
});

test("the undeclared-binding failure names the exact jigs bind invocation", async () => {
  seedThreeFailures();
  const body = (await (await trigger()).json()) as { failures: Failure[] };
  const binding = body.failures.find((failure) => failure.id === "binding.api");
  expect(binding?.repair).toContain("jigs bind");
  expect(binding?.repair).toContain("--name api");
});

test("GET /api/doctor reports red without creating a run", async () => {
  seedThreeFailures();
  const res = await app.request("/api/doctor");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    ok: boolean;
    failures?: never;
    checks: Failure[];
  };
  expect(body.ok).toBe(false);
  const failed = body.checks.filter((check) => !("ok" in check && check.ok));
  expect(failed.length).toBeGreaterThan(0);
  for (const failure of failed) expect(failure.repair).not.toBe("");
  // Doctor runs the whole catalog, not one pipeline's manifest.
  expect(body.checks.map((check) => check.id)).toContain("harness.codex-auth");
  expect(start).not.toHaveBeenCalled();
});

test("a green preflight lets the trigger call start()", async () => {
  const workspace = makeTmpDir();
  const { checkout, remoteDir } = makeRemoteBackedRepo(workspace);
  vi.stubEnv(
    "JIGS_FACTORY_ROOT",
    makeFactoryRepo(
      workspace,
      `bindings:\n  api:\n    path: ${checkout}\n    remote: ${remoteDir}\n`,
    ),
  );
  vi.stubEnv("LINEAR_API_KEY", "lin_live");
  vi.stubEnv("GITHUB_TOKEN", "ghp_live");
  vi.stubEnv("LINEAR_API_URL", "http://linear.test/graphql");
  vi.stubEnv("GITHUB_API_URL", "http://github.test");
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    if (url.startsWith("http://linear.test")) {
      return Response.json({ data: { viewer: { id: "u1", name: "Dev" } } });
    }
    if (url.startsWith("http://github.test/user")) {
      return Response.json({ login: "dev" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const res = await trigger();
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({
    runId: "wr_started",
    pipeline: "preflight-demo",
  });
  expect(start).toHaveBeenCalledTimes(1);
  removeTmpDir(workspace);
});

test("doctor names an unreadable factory config instead of staying silent", async () => {
  vi.stubEnv("LINEAR_API_KEY", "lin");
  vi.stubEnv("GITHUB_TOKEN", "gh");
  vi.stubEnv("JIGS_FACTORY_ROOT", path.join(tmp, "no-factory-here"));
  vi.stubGlobal("fetch", async () => Response.json({ data: { viewer: {} } }));
  const body = (await (await app.request("/api/doctor")).json()) as {
    checks: Failure[];
  };
  expect(body.checks.map((check) => check.id)).toContain(
    "binding.factory-config",
  );
});
