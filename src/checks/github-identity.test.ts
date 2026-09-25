import { beforeEach, expect, test, vi } from "vitest";
import type { AppIdentity } from "../config/factory-config.ts";
import { GithubApiError } from "../providers/github-api.ts";
import type { MergePolicy } from "../workflow/pull-requests/policy.ts";
import { runChecks } from "./catalog.ts";
import {
  type GithubIdentityProbes,
  type GithubMergePolicyProbes,
  githubIdentityChecks,
  mergePolicyCheck,
  realGithubMergePolicyProbes,
} from "./github-identity.ts";

const githubGetMock = vi.hoisted(() => vi.fn());
vi.mock("../providers/github-api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../providers/github-api.ts")>()),
  githubGet: githubGetMock,
}));

beforeEach(() => githubGetMock.mockReset());

const APP: AppIdentity = {
  mode: "app",
  appId: 4958325,
  installations: { salimhamed: 162033982 },
  privateKeyPath: "/factory/github-app.private-key.pem",
  operator: "salimhamed",
};

const GRANTED = {
  administration: "read",
  contents: "write",
  pull_requests: "write",
  issues: "write",
  metadata: "read",
  actions: "read",
  checks: "read",
  statuses: "read",
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
  bindings: Record<string, { remote: string }> = {},
  webhooks = false,
) => {
  const report = await runChecks(
    githubIdentityChecks([identity], merge, probes(overrides), env, { bindings, webhooks }),
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
  const check = await outcome(
    APP,
    "github.identity",
    {},
    { GITHUB_TOKEN: "ghp_live" },
    SQUASH_REVIEW,
    {},
    true,
  );
  expect(check).toMatchObject({
    ok: false,
    reason: expect.stringContaining("repository_hooks: write"),
  });
  if (check.ok) throw new Error("expected a failure");
  expect(check.reason).toContain("the webhook that wakes parked runs");
  expect(check.repair).toContain("Repository webhooks");
  expect(check.repair).toContain("accept the updated permissions on the installation");
});

test("repository administration read is required to inspect classic protection", async () => {
  const { administration: _ungranted, ...withoutAdministration } = GRANTED;
  const check = await outcome(APP, "github.identity", {
    installation: async () => ({ permissions: withoutAdministration }),
  });
  expect(check).toMatchObject({
    ok: false,
    reason: expect.stringContaining("administration: read"),
  });
});

test("jigs merging requires the App permissions used by merge-policy probes", async () => {
  const { actions: _actions, checks: _checks, statuses: _statuses, ...oldPermissions } = GRANTED;
  const check = await outcome(
    APP,
    "github.identity",
    { installation: async () => ({ permissions: oldPermissions }) },
    { GITHUB_TOKEN: "ghp_live" },
    SQUASH_REVIEW,
    { api: { remote: "git@github.com:acme/api.git" } },
  );
  expect(check).toMatchObject({ ok: false });
  if (check.ok !== false) throw new Error("expected failure");
  expect(check.reason).toContain("actions: read");
  expect(check.reason).toContain("checks: read");
  expect(check.reason).toContain("statuses: read");
});

test("preflight without binding probes does not require merge-policy-only App permissions", async () => {
  const { actions: _actions, ...preflightPermissions } = GRANTED;
  expect(
    await outcome(APP, "github.identity", {
      installation: async () => ({ permissions: preflightPermissions }),
    }),
  ).toMatchObject({ ok: true });
});

test("App review approval skips the PAT-only branch-rule probe permission", async () => {
  expect(
    await outcome(
      APP,
      "github.identity",
      { installation: async () => ({ permissions: GRANTED }) },
      { GITHUB_TOKEN: "ghp_live" },
      SQUASH_REVIEW,
      binding,
    ),
  ).toMatchObject({ ok: true });
});

test("human merging does not require merge-policy-only App permissions", async () => {
  const { actions: _actions, ...humanPermissions } = GRANTED;
  expect(
    await outcome(
      APP,
      "github.identity",
      { installation: async () => ({ permissions: humanPermissions }) },
      {},
      { ...SQUASH_REVIEW, by: "human" },
    ),
  ).toMatchObject({ ok: true });
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

const binding = { api: { remote: "git@github.com:acme/api.git" } };

test("real merge-policy probes use the repository and CI REST endpoints", async () => {
  const repository = {
    default_branch: "main",
    allow_merge_commit: true,
    allow_squash_merge: false,
    allow_rebase_merge: true,
  };
  githubGetMock
    .mockResolvedValueOnce(repository)
    .mockResolvedValueOnce({ total_count: 2 })
    .mockResolvedValueOnce({ total_count: 3 })
    .mockResolvedValueOnce({
      total_count: 3,
      workflows: [
        { state: "active" },
        { state: "disabled_inactivity" },
        { state: "disabled_manually" },
      ],
    });

  await expect(realGithubMergePolicyProbes.repository("acme", "api")).resolves.toEqual(repository);
  await expect(realGithubMergePolicyProbes.checkRuns("acme", "api", "main/head")).resolves.toBe(2);
  await expect(
    realGithubMergePolicyProbes.commitStatuses("acme", "api", "main/head"),
  ).resolves.toBe(3);
  await expect(realGithubMergePolicyProbes.actionsWorkflows("acme", "api")).resolves.toBe(1);

  expect(githubGetMock.mock.calls.map(([url]) => url)).toEqual([
    "/repos/acme/api",
    "/repos/acme/api/commits/main%2Fhead/check-runs?per_page=1",
    "/repos/acme/api/commits/main%2Fhead/status?per_page=1",
    "/repos/acme/api/actions/workflows?per_page=100&page=1",
  ]);
});

test("real label probe distinguishes absence from unreadable state", async () => {
  githubGetMock.mockRejectedValueOnce(new GithubApiError(404, "/labels/jigs", "not found"));
  await expect(
    realGithubMergePolicyProbes.labelExists("acme", "api", "jigs:approved"),
  ).resolves.toBe(false);
  expect(githubGetMock).toHaveBeenCalledWith("/repos/acme/api/labels/jigs%3Aapproved");

  githubGetMock.mockRejectedValueOnce(new GithubApiError(403, "/labels/jigs", "forbidden"));
  await expect(
    realGithubMergePolicyProbes.labelExists("acme", "api", "jigs:approved"),
  ).rejects.toThrow("forbidden");
});

test("the protection probe combines classic protection and rulesets", async () => {
  githubGetMock
    .mockResolvedValueOnce({
      required_status_checks: { contexts: ["classic-ci"] },
      required_pull_request_reviews: { required_approving_review_count: 1 },
    })
    .mockResolvedValueOnce([
      {
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "ruleset-ci" }] },
      },
      { type: "pull_request", parameters: { required_approving_review_count: 2 } },
    ]);
  await expect(
    realGithubMergePolicyProbes.protection("acme", "api", "release/v1"),
  ).resolves.toEqual({
    requiredApprovingReviews: 2,
    unread: null,
  });
  expect(githubGetMock.mock.calls.map(([url]) => url)).toEqual([
    "/repos/acme/api/branches/release%2Fv1/protection",
    "/repos/acme/api/rules/branches/release%2Fv1",
  ]);
});

test("the classic-protection probe reports required reviews", async () => {
  githubGetMock.mockResolvedValueOnce({
    required_status_checks: { contexts: ["legacy"], checks: [{ context: "build" }] },
    required_pull_request_reviews: { required_approving_review_count: 1 },
  });
  githubGetMock.mockResolvedValueOnce([]);
  await expect(
    realGithubMergePolicyProbes.protection("acme", "api", "release/v1"),
  ).resolves.toEqual({
    requiredApprovingReviews: 1,
    unread: null,
  });
});

test("an unprotected branch with no rulesets reads as no protection, not as a failure", async () => {
  githubGetMock.mockRejectedValueOnce(
    new GithubApiError(404, "/branches/main/protection", "Branch not protected"),
  );
  githubGetMock.mockResolvedValueOnce([]);
  await expect(realGithubMergePolicyProbes.protection("acme", "api", "main")).resolves.toBeNull();
});

test("the protection probe falls back from classic protection to rulesets", async () => {
  githubGetMock.mockRejectedValueOnce(
    new GithubApiError(404, "/branches/main/protection", "not accessible"),
  );
  githubGetMock.mockResolvedValueOnce([
    {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "build" }, { context: "test" }] },
    },
    { type: "pull_request", parameters: { required_approving_review_count: 2 } },
  ]);

  await expect(realGithubMergePolicyProbes.protection("acme", "api", "main")).resolves.toEqual({
    requiredApprovingReviews: 2,
    unread: null,
  });
  expect(githubGetMock.mock.calls.map(([url]) => url)).toEqual([
    "/repos/acme/api/branches/main/protection",
    "/repos/acme/api/rules/branches/main",
  ]);
});

test("the protection probe names the leg it could not read and rejects when neither answers", async () => {
  githubGetMock
    .mockRejectedValueOnce(new GithubApiError(403, "/branches/main/protection", "forbidden"))
    .mockResolvedValueOnce([
      { type: "pull_request", parameters: { required_approving_review_count: 3 } },
    ]);
  await expect(realGithubMergePolicyProbes.protection("acme", "api", "main")).resolves.toEqual({
    requiredApprovingReviews: 3,
    unread: "classic",
  });

  githubGetMock
    .mockResolvedValueOnce({ required_status_checks: { contexts: ["ci"] } })
    .mockRejectedValueOnce(new Error("rules unavailable"));
  await expect(realGithubMergePolicyProbes.protection("acme", "api", "main")).resolves.toEqual({
    requiredApprovingReviews: 0,
    unread: "rulesets",
  });

  githubGetMock
    .mockRejectedValueOnce(new Error("forbidden"))
    .mockRejectedValueOnce(new Error("forbidden"));
  await expect(realGithubMergePolicyProbes.protection("acme", "api", "main")).rejects.toThrow(
    "could not read classic protection or rulesets",
  );
});

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
  actionsWorkflows: async () => 0,
  labelExists: async () => true,
  protection: async () => ({ requiredApprovingReviews: 1, unread: null }),
  ...overrides,
});

async function policyOutcome(
  merge: MergePolicy = SQUASH_REVIEW,
  bindings: Record<string, { remote: string }> = binding,
  overrides: Partial<GithubMergePolicyProbes> = {},
  identity: AppIdentity | { mode: "pat" } = { mode: "pat" },
) {
  const report = await runChecks([
    mergePolicyCheck(identity, merge, bindings, policyProbes(overrides)),
  ]);
  return report.checks[0];
}

test("a healthy binding preserves the existing passing merge-policy line", async () => {
  expect(await policyOutcome()).toEqual({
    id: "github.merge-policy",
    label: "merge policy",
    ok: true,
    detail:
      "api: jigs merges with squash once GitHub reports it mergeable and an approving GitHub review of the current commit is present",
  });
});

test("a pull-request-only ruleset with no approvals or checks is fine under review approval", async () => {
  expect(
    await policyOutcome(SQUASH_REVIEW, binding, {
      protection: async () => ({ requiredApprovingReviews: 0, unread: null }),
    }),
  ).toMatchObject({
    id: "github.merge-policy",
    ok: true,
    detail: expect.stringContaining("an approving GitHub review of the current commit is present"),
  });
});

test("a repository with no branch protection at all is fine", async () => {
  expect(
    await policyOutcome(SQUASH_REVIEW, binding, { protection: async () => null }),
  ).toMatchObject({ ok: true });
});

test.each([
  [
    "unreadable classic protection",
    { requiredApprovingReviews: 0, unread: "classic" as const },
    "read acme/api's rulesets but not its classic branch protection",
    "grant the GitHub App Administration: read",
  ],
  [
    "unreadable rulesets",
    { requiredApprovingReviews: 0, unread: "rulesets" as const },
    "read acme/api's classic branch protection but not its rulesets",
    "reading rulesets needs no extra permission",
  ],
])(
  "%s reports which half jigs could not read and how to repair that half",
  async (_case, protection, reason, repair) => {
    expect(
      await policyOutcome(LABEL_POLICY, binding, { protection: async () => protection }, APP),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining(reason),
      repair: expect.stringContaining(repair),
    });
  },
);

test("the effective merge policy is reported and checked per binding", async () => {
  const bindings = {
    api: { remote: "git@github.com:acme/api.git", merge: { method: "rebase" as const } },
    docs: { remote: "git@github.com:acme/docs.git", merge: { by: "human" as const } },
  };
  expect(await policyOutcome(SQUASH_REVIEW, bindings)).toMatchObject({
    ok: true,
    detail: expect.stringMatching(/^api: jigs merges with rebase.*; docs: a human merges/),
  });
});

test("jigs merging fails when the default branch has no CI", async () => {
  expect(await policyOutcome(SQUASH_REVIEW, binding, { checkRuns: async () => 0 })).toMatchObject({
    ok: false,
    reason: expect.stringContaining("api: acme/api has no active Actions workflows"),
    repair: expect.stringContaining('set bindings.api.merge.by to "human" in jigs.config.ts'),
  });
});

test("a pull-request-only Actions workflow counts as CI without checks on main", async () => {
  expect(
    await policyOutcome(SQUASH_REVIEW, binding, {
      checkRuns: async () => 0,
      actionsWorkflows: async () => 1,
    }),
  ).toMatchObject({ ok: true });
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
    repair: expect.stringContaining(`bindings.api.merge.method in jigs.config.ts`),
  });
});

test("an omitted merge-method setting is unknown rather than disabled", async () => {
  const repository = await policyProbes().repository("acme", "api");
  const { allow_squash_merge: _omitted, ...withoutSquashVerdict } = repository;
  expect(
    await policyOutcome(SQUASH_REVIEW, binding, {
      repository: async () => withoutSquashVerdict,
    }),
  ).toMatchObject({ ok: true });
});

const LABEL_POLICY: MergePolicy = {
  by: "jigs",
  method: "squash",
  approval: { kind: "label", name: "jigs:approved" },
};

test("label approval fails when native approving reviews are required", async () => {
  const result = await policyOutcome(LABEL_POLICY, binding, {
    protection: async () => ({
      requiredApprovingReviews: 2,
      unread: null,
    }),
  });
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("requires 2 approving reviews"),
    repair: expect.stringContaining("switch this factory's approval"),
  });
  if (result?.ok !== false) throw new Error("expected failure");
  expect(result.repair).toContain("switch this factory's approval");
});

test("App label approval rejects native required reviews", async () => {
  const protection = vi.fn(async () => ({
    requiredApprovingReviews: 1,
    unread: null,
  }));
  await expect(policyOutcome(LABEL_POLICY, binding, { protection }, APP)).resolves.toMatchObject({
    ok: false,
    reason: expect.stringContaining("this factory approves with a label"),
  });
  expect(protection).toHaveBeenCalledOnce();
});

test("a hung repository probe stays silent before the check catalog times out", async () => {
  await expect(
    runChecks(
      [
        mergePolicyCheck(
          { mode: "pat" },
          SQUASH_REVIEW,
          binding,
          policyProbes({ repository: async () => new Promise(() => {}) }),
          5,
        ),
      ],
      50,
    ),
  ).resolves.toMatchObject({
    ok: true,
    checks: [{ id: "github.merge-policy", ok: true }],
  });
});

test("label approval fails when the configured label does not exist", async () => {
  const result = await policyOutcome(LABEL_POLICY, binding, {
    labelExists: async () => false,
  });
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("has no jigs:approved label"),
    repair: expect.stringContaining("re-run pnpm exec jigs bind"),
  });
  if (result?.ok !== false) throw new Error("expected failure");
  expect(result.reason).toContain(
    "jigs merges with squash once GitHub reports it mergeable and the jigs:approved label is present",
  );
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

test("an unreadable binding does not hide another binding's findings", async () => {
  const result = await policyOutcome(
    SQUASH_REVIEW,
    {
      broken: { remote: "git@github.com:acme/broken.git" },
      web: { remote: "git@github.com:acme/web.git" },
    },
    {
      repository: async (_owner, repo) => {
        if (repo === "broken") throw new Error("repository unreadable");
        return policyProbes().repository("acme", repo);
      },
      checkRuns: async () => 0,
    },
  );
  expect(result).toMatchObject({ ok: false });
  if (result?.ok !== false) throw new Error("expected failure");
  expect(result.reason).toContain("web: acme/web has no active Actions workflows");
  expect(result.reason).not.toContain("repository unreadable");
});

test("human merging does not probe or report repository policy", async () => {
  const repository = vi.fn();
  const result = await policyOutcome({ ...SQUASH_REVIEW, by: "human" }, binding, { repository });
  expect(result).toMatchObject({ ok: true });
  expect(repository).not.toHaveBeenCalled();
});

test("a jigs policy with no selected bindings does not probe repositories", async () => {
  const repository = vi.fn();
  expect(await policyOutcome(SQUASH_REVIEW, {}, { repository })).toMatchObject({ ok: true });
  expect(repository).not.toHaveBeenCalled();
});

test("an inaccessible repository stays silent for the merge-policy check", async () => {
  expect(
    await policyOutcome(SQUASH_REVIEW, binding, {
      repository: async () => {
        throw new Error("GitHub API 403: rate limited");
      },
    }),
  ).toMatchObject({ ok: true });
});

test.each([
  [APP, "grant the GitHub App Administration: read"],
  [{ mode: "pat" as const }, "replace GITHUB_TOKEN with a PAT"],
])("unreadable protection gives identity-specific guidance", async (identity, repair) => {
  expect(
    await policyOutcome(
      LABEL_POLICY,
      binding,
      {
        protection: async () => {
          throw new Error("forbidden");
        },
      },
      identity,
    ),
  ).toMatchObject({ ok: false, repair: expect.stringContaining(repair) });
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
      SQUASH_REVIEW,
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
