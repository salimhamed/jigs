import { expect, test, vi } from "vitest";
import type { AppIdentity, MergePolicy } from "../config/factory-config.ts";
import { runChecks } from "./catalog.ts";
import {
  type GithubIdentityProbes,
  type GithubMergePolicyProbes,
  githubIdentityChecks,
  mergePolicyCheck,
} from "./github-identity.ts";

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

const SQUASH_REVIEW: MergePolicy = {
  by: "jigs",
  method: "squash",
  approval: { kind: "review" },
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
      readPrivateKey: () => ({
        key: "-----BEGIN PRIVATE KEY-----",
        looseMode: "0644",
      }),
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
      installation: async () => ({
        permissions: { ...GRANTED, contents: "read" },
      }),
    }),
  ).toMatchObject({
    ok: false,
    reason: expect.stringContaining("contents: write"),
  });
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
      {
        by: "human",
        method: "rebase",
        approval: { kind: "label", name: "jigs:approved" },
      },
    ),
  ).toMatchObject({
    ok: true,
    detail:
      "a human merges; jigs only watches (the jigs:approved label would be the signal if merge.by were jigs)",
  });
});

const binding = { api: { remote: "git@github.com:acme/api.git" } };
const policyProbes = (
  overrides: Partial<GithubMergePolicyProbes> = {},
): GithubMergePolicyProbes => ({
  repository: async () => ({
    default_branch: "main",
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
  }),
  checkRuns: async () => 1,
  commitStatuses: async () => 0,
  labelExists: async () => true,
  requiredApprovingReviews: async () => 0,
  ...overrides,
});

async function policyOutcome(
  merge: MergePolicy = SQUASH_REVIEW,
  bindings: Record<string, { remote: string }> = binding,
  overrides: Partial<GithubMergePolicyProbes> = {},
) {
  const report = await runChecks([mergePolicyCheck(merge, bindings, policyProbes(overrides))]);
  return report.checks[0];
}

test("a healthy binding preserves the existing passing merge-policy line", async () => {
  expect(await policyOutcome()).toEqual({
    id: "github.merge-policy",
    label: "merge policy",
    ok: true,
    detail:
      "jigs merges with squash once GitHub reports it mergeable and an approving GitHub review of the current commit is present",
  });
});

test("jigs merging fails when the default branch has no CI", async () => {
  expect(await policyOutcome(SQUASH_REVIEW, binding, { checkRuns: async () => 0 })).toMatchObject({
    ok: false,
    reason: expect.stringContaining("api: acme/api's default branch has no check runs"),
    repair: expect.stringContaining('set merge.by to "human" in jigs.config.ts'),
  });
});

test.each([
  ["squash", "allow_squash_merge"],
  ["merge", "allow_merge_commit"],
  ["rebase", "allow_rebase_merge"],
] as const)("a disabled %s method fails", async (method, property) => {
  const result = await policyOutcome({ ...SQUASH_REVIEW, method }, binding, {
    repository: async () => ({
      ...(await policyProbes().repository("acme", "api")),
      [property]: false,
    }),
  });
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining(`${method} merges are disabled`),
    repair: expect.stringContaining("merge.method in jigs.config.ts"),
  });
});

const LABEL_POLICY: MergePolicy = {
  by: "jigs",
  method: "squash",
  approval: { kind: "label", name: "jigs:approved" },
};

test("label approval fails when native approving reviews are required", async () => {
  expect(
    await policyOutcome(LABEL_POLICY, binding, {
      requiredApprovingReviews: async () => 2,
    }),
  ).toMatchObject({
    ok: false,
    reason: expect.stringContaining("requires 2 approving reviews"),
    repair: expect.stringContaining("merge.approval"),
  });
});

test("label approval fails when the configured label does not exist", async () => {
  expect(
    await policyOutcome(LABEL_POLICY, binding, {
      labelExists: async () => false,
    }),
  ).toMatchObject({
    ok: false,
    reason: expect.stringContaining("has no jigs:approved label"),
    repair: expect.stringContaining("create the jigs:approved label"),
  });
});

test("findings from several bindings are folded into one named failure", async () => {
  const result = await policyOutcome(
    SQUASH_REVIEW,
    {
      api: { remote: "git@github.com:acme/api.git" },
      web: { remote: "https://github.com/acme/web.git" },
    },
    { checkRuns: async () => 0 },
  );
  expect(result).toMatchObject({ ok: false });
  if (result?.ok !== false) throw new Error("expected failure");
  expect(result.reason).toContain("api: acme/api");
  expect(result.reason).toContain("web: acme/web");
});

test("human merging does not probe or report repository policy", async () => {
  const repository = vi.fn();
  const result = await policyOutcome({ ...SQUASH_REVIEW, by: "human" }, binding, { repository });
  expect(result).toMatchObject({ ok: true });
  expect(repository).not.toHaveBeenCalled();
});

test("an unreadable approvals rule stays silent", async () => {
  expect(
    await policyOutcome(LABEL_POLICY, binding, {
      requiredApprovingReviews: async () => {
        throw new Error("forbidden");
      },
    }),
  ).toMatchObject({ ok: true });
});
