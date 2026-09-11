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
import { z } from "zod";
import { ensureBindingClone } from "../steps/worktree/clone.ts";
import { bindingRepoDir } from "../steps/worktree/layout.ts";
// Real git fixtures, reached by path: they are test-only, so they stay out
// of the package's export map.
import {
  makeFactoryRepo,
  makeRemoteBackedRepo,
  makeTmpDir,
  removeTmpDir,
} from "../test-fixtures.ts";

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

const { createApp } = await import("./app.ts");

// A fixture rather than a demo: what preflight owes the trigger path is the
// same whatever pipelines a factory declares, and this one declares exactly
// the requirement the assertions below are about.
const app = createApp({
  pipelines: {
    bound: {
      pipeline: async () => undefined,
      inputs: z.object({}),
      requires: { bindings: ["api"], harnesses: ["claude"] },
    },
  },
});

// Doctor's schedule half needs a factory that declares one: those checks are
// the factory's own, so they can only arrive through the app.
const scheduledApp = createApp({
  pipelines: {
    bound: { pipeline: async () => undefined, inputs: z.object({}) },
  },
  schedules: { nightly: { pipeline: "bound", cron: "always", inputs: {} } },
});

let tmp: string;
let claudeStub: string;
let seededFactory: string;

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
  seededFactory = makeFactoryRepo(tmp, "bindings: {}\n");
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
  vi.stubEnv("JIGS_FACTORY_ROOT", seededFactory);
}

const trigger = () =>
  app.request("/api/pipelines/bound/runs", {
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
  // A local bare repo stands in for GitHub: the binding check is a git
  // ls-remote against the URL, and this one answers offline.
  const { remoteDir } = makeRemoteBackedRepo(workspace);
  const factory = makeFactoryRepo(
    workspace,
    `bindings:\n  api:\n    remote: ${remoteDir}\n`,
  );
  vi.stubEnv("JIGS_FACTORY_ROOT", factory);
  vi.stubEnv("XDG_DATA_HOME", path.join(workspace, "data"));
  // What the service does at start: preflight refuses a binding with no clone.
  await ensureBindingClone({
    repoDir: bindingRepoDir({ factoryRoot: factory, bindingName: "api" }),
    remote: remoteDir,
  });
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
    pipeline: "bound",
  });
  expect(start).toHaveBeenCalledTimes(1);
  removeTmpDir(workspace);
});

test("doctor reports a malformed schedule beside the catalog's own checks", async () => {
  seedThreeFailures();
  const body = (await (await scheduledApp.request("/api/doctor")).json()) as {
    ok: boolean;
    checks: Failure[];
  };
  expect(body.ok).toBe(false);
  const schedule = body.checks.find((check) => check.id === "schedule.nightly");
  expect(schedule?.label).toBe("schedule nightly");
  expect(schedule?.repair).toContain("fix schedules.nightly.cron");
  // Still the whole catalog: the schedule checks are appended to it, not a
  // replacement for it.
  expect(body.checks.map((check) => check.id)).toContain("core.github-token");
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
