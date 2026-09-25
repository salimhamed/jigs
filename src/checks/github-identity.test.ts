import { expect, test, vi } from "vitest";
import type { AppIdentity } from "../config/factory-config.ts";
import { runChecks } from "./catalog.ts";
import { type GithubIdentityProbes, githubIdentityChecks } from "./github-identity.ts";

const APP: AppIdentity = {
  mode: "app",
  appId: 4958325,
  installations: { salimhamed: 162033982 },
  privateKeyPath: "/factory/github-app.private-key.pem",
  operator: "salimhamed",
};

const GRANTED = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  metadata: "read",
  checks: "read",
  statuses: "read",
};

const probes = (overrides: Partial<GithubIdentityProbes> = {}): GithubIdentityProbes => ({
  whoami: async () => ({ login: "salimhamed" }),
  readPrivateKey: () => ({ key: "-----BEGIN PRIVATE KEY-----" }),
  installation: async () => ({ permissions: GRANTED }),
  registration: async () => ({ slug: "jigs-app-dev" }),
  ...overrides,
});

const outcome = async (
  identity: AppIdentity | { mode: "pat" },
  id: string,
  overrides: Partial<GithubIdentityProbes> = {},
  env: NodeJS.ProcessEnv = { GITHUB_TOKEN: "ghp_live" },
  webhooks = false,
) => {
  const report = await runChecks(
    githubIdentityChecks([identity], probes(overrides), env, { webhooks }),
  );
  const found = report.checks.find((check) => check.id === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
};

test("pat mode reports the login the token belongs to", async () => {
  expect(await outcome({ mode: "pat" }, "github.identity")).toEqual({
    id: "github.identity",
    label: "GitHub identity",
    ok: true,
    detail: "jigs acts as salimhamed",
  });
});

test("pat mode fails before probing when there is no token", async () => {
  expect(await outcome({ mode: "pat" }, "github.identity", {}, {})).toMatchObject({
    ok: false,
    reason: expect.stringContaining("GITHUB_TOKEN is not set"),
    repair: expect.stringContaining("pnpm exec jigs service restart"),
  });
});

test("app mode names the bot it acts as and the operator it acts for", async () => {
  expect(await outcome(APP, "github.identity")).toMatchObject({
    ok: true,
    detail: "jigs acts as jigs-app-dev[bot] on salimhamed; operator salimhamed",
  });
});

test("an unreadable private key is the first thing said", async () => {
  expect(
    await outcome(APP, "github.identity", {
      readPrivateKey: () => {
        throw new Error("cannot read the GitHub App private key");
      },
    }),
  ).toMatchObject({
    ok: false,
    reason: expect.stringContaining("cannot read"),
    repair: expect.stringContaining("chmod 600 /factory/github-app.private-key.pem"),
  });
});

test("a key anyone on the machine can read is a key anyone can act as the App with", async () => {
  expect(
    await outcome(APP, "github.identity", {
      readPrivateKey: () => ({ key: "-----BEGIN PRIVATE KEY-----", looseMode: "0644" }),
    }),
  ).toMatchObject({
    ok: false,
    reason: expect.stringContaining("mode 0644"),
    repair: "chmod 600 /factory/github-app.private-key.pem",
  });
});

test("an installation that does not answer names the three facts that address it", async () => {
  expect(
    await outcome(APP, "github.identity", {
      installation: async () => {
        throw new Error("GitHub API 404 on /app/installations/162033982");
      },
    }),
  ).toMatchObject({
    ok: false,
    reason: expect.stringContaining("162033982"),
    repair: expect.stringContaining("installations"),
  });
});

test("without GitHub webhooks an App needs no webhook administration", async () => {
  expect(await outcome(APP, "github.identity")).toMatchObject({ ok: true });
});

test("with GitHub webhooks on, webhook administration is a permission to grant and accept", async () => {
  const check = await outcome(APP, "github.identity", {}, { GITHUB_TOKEN: "ghp_live" }, true);
  expect(check).toMatchObject({
    ok: false,
    reason: expect.stringContaining("repository_hooks: write"),
  });
  if (check.ok) throw new Error("expected a failure");
  expect(check.reason).toContain("the webhook that wakes parked runs");
  expect(check.repair).toContain("Repository webhooks");
  expect(check.repair).toContain("accept the updated permissions on the installation");
});

test("reading CI requires the checks and statuses permissions", async () => {
  const { checks: _checks, statuses: _statuses, ...withoutCi } = GRANTED;
  const check = await outcome(APP, "github.identity", {
    installation: async () => ({ permissions: withoutCi }),
  });
  expect(check).toMatchObject({ ok: false });
  if (check.ok !== false) throw new Error("expected failure");
  expect(check.reason).toContain("checks: read");
  expect(check.reason).toContain("statuses: read");
});

test("a read grant does not satisfy a write requirement", async () => {
  expect(
    await outcome(APP, "github.identity", {
      installation: async () => ({ permissions: { ...GRANTED, contents: "read" } }),
    }),
  ).toMatchObject({ ok: false, reason: expect.stringContaining("contents: write") });
});

test("doctor probes every installation and registration once per App", async () => {
  const app = APP;
  const installation = vi.fn(async () => ({ permissions: GRANTED }));
  const registration = vi.fn(async () => ({ slug: "jigs-app-dev" }));
  const report = await runChecks(
    githubIdentityChecks(
      [
        { ...app, installations: { salimhamed: 1, downstreamimpact: 2, Junglescout: 3 } },
        { ...app, appId: 5, installations: { Other: 4 } },
      ],
      probes({ installation, registration }),
    ),
  );
  expect(report.ok).toBe(true);
  expect(installation.mock.calls).toHaveLength(4);
  expect(registration.mock.calls).toHaveLength(2);
  expect(report.checks[0]).toMatchObject({
    detail:
      "jigs acts as jigs-app-dev[bot] on salimhamed, downstreamimpact, Junglescout; operator salimhamed",
  });
});

test("multi-App key repairs identify the App entry rather than the singular config shape", async () => {
  const result = await outcome(APP, "github.identity", {
    readPrivateKey: () => {
      throw new Error("missing key");
    },
  });
  expect(result).toMatchObject({ ok: false, repair: expect.stringContaining(`App ${APP.appId}`) });
  if (!result.ok) {
    expect(result.repair).toContain("privateKeyPath");
    expect(result.repair).not.toContain("github.identity.");
  }
});

test("missing permissions retain the installation that failed", async () => {
  const app = APP;
  const result = await outcome(
    { ...app, installations: { first: 10, second: 20 } },
    "github.identity",
    {
      installation: async ({ installationId }) => ({
        permissions: installationId === 10 ? GRANTED : { ...GRANTED, contents: "read" },
      }),
    },
  );
  expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("installation 20") });
  if (!result.ok) expect(result.reason).not.toContain("installation 10");
});
