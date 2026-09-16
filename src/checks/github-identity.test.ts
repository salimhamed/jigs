import { expect, test } from "vitest";
import type { AppIdentity, MergePolicy } from "../config/factory-config.ts";
import { runChecks } from "./catalog.ts";
import { type GithubIdentityProbes, githubIdentityChecks } from "./github-identity.ts";

const APP: AppIdentity = {
  mode: "app",
  appId: 4958325,
  installationId: 162033982,
  privateKeyPath: "/factory/github-app.private-key.pem",
  operator: "salimhamed",
};

const GRANTED = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  metadata: "read",
  repository_hooks: "write",
};

const SQUASH_REVIEW: MergePolicy = { by: "jigs", method: "squash", approval: { kind: "review" } };

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
  merge: MergePolicy = SQUASH_REVIEW,
) => {
  const report = await runChecks(githubIdentityChecks(identity, merge, probes(overrides), env));
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
    repair: expect.stringContaining("jigs service restart"),
  });
});

test("app mode names the bot it acts as and the operator it acts for", async () => {
  expect(await outcome(APP, "github.identity")).toMatchObject({
    ok: true,
    detail: "jigs acts as jigs-app-dev[bot]; operator salimhamed",
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
    repair: expect.stringContaining("installationId"),
  });
});

test("webhook administration is a permission the operator has to grant and accept", async () => {
  const { repository_hooks: _ungranted, ...withoutHooks } = GRANTED;
  const check = await outcome(APP, "github.identity", {
    installation: async () => ({ permissions: withoutHooks }),
  });
  expect(check).toMatchObject({
    ok: false,
    reason: expect.stringContaining("repository_hooks: write"),
  });
  if (check.ok) throw new Error("expected a failure");
  expect(check.reason).toContain("the webhook that wakes parked runs");
  expect(check.repair).toContain("Repository webhooks");
  expect(check.repair).toContain("accept the updated permissions on the installation");
});

test("a read grant does not satisfy a write requirement", async () => {
  expect(
    await outcome(APP, "github.identity", {
      installation: async () => ({ permissions: { ...GRANTED, contents: "read" } }),
    }),
  ).toMatchObject({ ok: false, reason: expect.stringContaining("contents: write") });
});

test("the effective policy is one line, whichever identity holds it", async () => {
  expect(await outcome({ mode: "pat" }, "github.merge-policy")).toMatchObject({
    label: "merge policy",
    ok: true,
    detail:
      "jigs merges with squash once GitHub reports it mergeable and an approving GitHub review of the current commit is present",
  });
  expect(
    await outcome(
      APP,
      "github.merge-policy",
      {},
      {},
      { by: "human", method: "rebase", approval: { kind: "label", name: "jigs:approved" } },
    ),
  ).toMatchObject({
    ok: true,
    detail:
      "a human merges; jigs only watches (the jigs:approved label would be the signal if merge.by were jigs)",
  });
});
