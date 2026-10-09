import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { ensureBindingClone } from "../steps/workspaces/clone.ts";
import { cloneRepoDir } from "../steps/workspaces/layout.ts";
// Real git fixtures, reached by path: they are test-only, so they stay out
// of the package's export map.
import {
  makeFactoryRepo,
  makeRemoteBackedRepo,
  makeTmpDir,
  removeTmpDir,
} from "../test-fixtures.ts";
import { harnesses } from "../workflow/agents/harness-config.ts";
import { appClient } from "./test-fixtures.ts";

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

vi.stubEnv("WORKFLOW_TARGET_WORLD", undefined);
vi.stubEnv("WORKFLOW_POSTGRES_URL", undefined);

const { createApp } = await import("./app.ts");

// A fixture rather than a demo: what preflight owes the trigger path is the
// same whatever workflows a factory declares, and this one declares exactly
// the requirement the assertions below are about.
const app = appClient(
  createApp({
    workflows: {
      bound: {
        workflow: async () => undefined,
        inputs: z.object({}),
        requires: {
          bindings: ["api"],
          agents: {
            builder: harnesses.claude({
              model: "opus",
              linear: { installationName: "linear-acme" },
            }),
          },
          integrations: ["linear", "github"],
        },
      },
    },
  }),
);

const inputBoundApp = appClient(
  createApp({
    workflows: {
      ship: {
        workflow: async () => undefined,
        inputs: z.object({ binding: z.string() }),
        // Deliberately absent from the fixtures: the run input must replace it.
        requires: { bindings: ["unrelated"] },
      },
    },
  }),
);

// Doctor's schedule half needs a factory that declares one: those checks are
// the factory's own, so they can only arrive through the app.
const scheduledApp = appClient(
  createApp({
    workflows: {
      bound: { workflow: async () => undefined, inputs: z.object({}) },
    },
    schedules: {
      nightly: { active: true, workflow: "bound", cron: "always", inputs: {} },
      quiet: { active: false, workflow: "bound", cron: "always", inputs: {} },
    },
    triggers: {
      pages: { active: true, workflow: "bound", source: { kind: "nope.pages", params: {} } },
      off: { active: false, workflow: "bound", source: { kind: "nope.pages", params: {} } },
    },
  }),
);

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
  // A real executable answering the real flags, so the harness checks run
  // their actual code paths without needing this machine's login or CLI.
  claudeStub = path.join(tmp, "claude-stub");
  writeFileSync(
    claudeStub,
    `#!/bin/sh\ncase "$1" in\n  --version) echo '2.1.270 (Claude Code)' ;;\n  *) echo '${SUBSCRIPTION_STATUS}' ;;\nesac\n`,
  );
  chmodSync(claudeStub, 0o755);
  seededFactory = makeFactoryRepo(tmp, { bindings: {} });
});
afterAll(() => {
  removeTmpDir(tmp);
});

beforeEach(() => {
  start.mockClear();
  vi.unstubAllEnvs();
  vi.stubEnv("WORKFLOW_LOCAL_DATA_DIR", tmp);
  vi.stubEnv("WORKFLOW_TARGET_WORLD", undefined);
  vi.stubEnv("WORKFLOW_POSTGRES_URL", undefined);
  vi.stubEnv("JIGS_CLAUDE_EXECUTABLE", claudeStub);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function seedFailures(): void {
  vi.stubEnv("JIGS_HUB_TOKEN", "");
  vi.spyOn(process, "cwd").mockReturnValue(seededFactory);
}

const trigger = () =>
  app.request("/api/workflows/bound/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs: {} }),
  });

const triggerInputBinding = (binding: string) =>
  inputBoundApp.request("/api/workflows/ship/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs: { binding } }),
  });

interface Failure {
  id: string;
  label: string;
  reason: string;
  repair: string;
}

test("a trigger with several seeded failures is refused with all of them at once", async () => {
  seedFailures();
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
    "linear.installations",
  ]);
  for (const failure of body.failures) {
    expect(failure.reason).not.toBe("");
    expect(failure.repair).not.toBe("");
  }
  expect(body.runId).toBeUndefined();
  expect(start).not.toHaveBeenCalled();
});

test("the undeclared-binding failure names the exact jigs bind invocation", async () => {
  seedFailures();
  const body = (await (await trigger()).json()) as { failures: Failure[] };
  const binding = body.failures.find((failure) => failure.id === "binding.api");
  expect(binding?.repair).toContain("jigs bind");
  expect(binding?.repair).toContain("--binding-name api");
});

test("an input-driven workflow preflights the binding named by the run", async () => {
  vi.spyOn(process, "cwd").mockReturnValue(seededFactory);
  const res = await triggerInputBinding("playground");
  expect(res.status).toBe(424);
  const body = (await res.json()) as { failures: Failure[] };
  expect(body.failures.map((failure) => failure.id)).toEqual(["binding.playground"]);
  expect(body.failures[0]?.reason).toContain("playground");
  expect(start).not.toHaveBeenCalled();
});

test("an input-driven workflow ignores an unrelated static binding", async () => {
  const workspace = makeTmpDir();
  const { remoteDir } = makeRemoteBackedRepo(workspace);
  const factory = makeFactoryRepo(workspace, {
    bindings: { playground: { remote: remoteDir, installationName: "acme" } },
  });
  vi.spyOn(process, "cwd").mockReturnValue(factory);
  await ensureBindingClone({
    repoDir: cloneRepoDir({ factoryRoot: factory, bindingName: "playground" }),
    remote: remoteDir,
  });

  const res = await triggerInputBinding("playground");
  expect(res.status).toBe(201);
  expect(start).toHaveBeenCalledTimes(1);
  removeTmpDir(workspace);
});

test("GET /api/doctor reports rejected configured credentials without creating a run", async () => {
  seedFailures();
  vi.stubEnv("JIGS_HUB_TOKEN", "rejected-token");
  vi.stubGlobal("fetch", async () =>
    Response.json({ message: "Bad credentials" }, { status: 401 }),
  );
  const res = await app.request("/api/doctor");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    ok: boolean;
    failures?: never;
    checks: Failure[];
  };
  expect(body.ok).toBe(false);
  const failed = body.checks.filter((check) => !("ok" in check && check.ok));
  expect(failed.map((check) => check.id)).toContain("github.installations");
  for (const failure of failed) expect(failure.repair).not.toBe("");
  // Doctor reads every workflow's manifest for the harnesses the factory uses.
  expect(body.checks.map((check) => check.id)).toContain("harness.claude-auth");
  expect(body.checks.map((check) => check.id)).not.toContain("harness.codex-auth");
  expect(start).not.toHaveBeenCalled();
});

test("a green preflight lets the trigger call start()", async () => {
  const workspace = makeTmpDir();
  // A local bare repo stands in for GitHub: the binding check is a git
  // ls-remote against the URL, and this one answers offline.
  const { remoteDir } = makeRemoteBackedRepo(workspace);
  const factory = makeFactoryRepo(workspace, {
    bindings: { api: { remote: remoteDir, installationName: "acme" } },
  });
  vi.spyOn(process, "cwd").mockReturnValue(factory);
  vi.stubEnv("XDG_DATA_HOME", path.join(workspace, "data"));
  // What the service does at start: preflight refuses a binding with no clone.
  await ensureBindingClone({
    repoDir: cloneRepoDir({ factoryRoot: factory, bindingName: "api" }),
    remote: remoteDir,
  });
  vi.stubEnv("JIGS_HUB_TOKEN", "hub-token");
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    if (url === "https://hub.example.test/api/factory/tokens/linear") {
      return Response.json({
        token: "lin_oauth",
        expiresAt: "2999-01-01T00:00:00Z",
        app: { name: "jigs", userId: "app-user" },
      });
    }
    if (url === "https://hub.example.test/api/factory/tokens/github") {
      return Response.json({
        token: "ghs_test",
        expiresAt: "2999-01-01T00:00:00Z",
        account: "acme",
        app: { slug: "jigs-dev", botUserId: 1 },
      });
    }
    if (url === "https://hub.example.test/api/factory/status") {
      return Response.json({
        factory: { name: "dev" },
        organization: { name: "Acme" },
        apps: [
          {
            provider: "github",
            name: "jigs-dev",
            installations: [{ account: "acme", installationName: "acme" }],
          },
          {
            provider: "linear",
            name: "jigs",
            installations: [{ account: "Acme", installationName: "acme-linear" }],
          },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const res = await trigger();
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({
    runId: "wr_started",
    workflow: "bound",
  });
  expect(start).toHaveBeenCalledTimes(1);
  removeTmpDir(workspace);
});

test("doctor reports a malformed schedule and trigger beside the catalog's own checks", async () => {
  seedFailures();
  const body = (await (await scheduledApp.request("/api/doctor")).json()) as {
    ok: boolean;
    checks: Failure[];
  };
  expect(body.ok).toBe(false);
  const schedule = body.checks.find((check) => check.id === "schedule.nightly");
  expect(schedule?.label).toBe("schedule nightly");
  expect(schedule?.repair).toContain("fix schedules.nightly.cron");
  const trigger = body.checks.find((check) => check.id === "trigger.pages");
  expect(trigger?.reason).toBe('source "nope.pages" is not a source this jigs version provides');
  expect(body.checks.some((check) => check.id.startsWith("harness."))).toBe(false);
  // Inactive ones are never checked, however broken.
  expect(
    body.checks.filter((check) => ["schedule.quiet", "trigger.off"].includes(check.id)),
  ).toEqual([]);
});

test("doctor names an unreadable factory config instead of staying silent", async () => {
  const broken = makeFactoryRepo(path.join(tmp, "broken"), 'throw new Error("unreadable");\n');
  vi.spyOn(process, "cwd").mockReturnValue(broken);
  vi.stubGlobal("fetch", async () => Response.json({ data: { viewer: {} } }));
  const body = (await (await app.request("/api/doctor")).json()) as {
    checks: Failure[];
  };
  expect(body.checks.map((check) => check.id)).toContain("binding.factory-config");
});
