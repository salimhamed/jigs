// Which GitHub identity this factory runs as, and whether that credential
// actually works. The two modes fail in completely different ways — a rejected
// token versus an App whose key, installation or permissions are wrong — so
// each gets its own checks and its own repair.

import {
  type AppIdentity,
  type BindingEntry,
  bindingMergePolicy,
  type GithubIdentity,
  type MergePolicy,
} from "../config/factory-config.ts";
import { GithubApiError, githubGet } from "../providers/github-api.ts";
import {
  fetchAppInstallation,
  fetchAppRegistration,
  readAppPrivateKey,
} from "../providers/github-auth.ts";
import { parseGithubRemote } from "../providers/github-webhook.ts";
import { type Check, type CheckResult, PROBE_TIMEOUT_MS } from "./catalog.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "./core.ts";

// What jigs needs of an installation, and why. `repository_hooks` is the one
// operators miss: `jigs bind` creates the per-repo webhook that wakes every
// parked pull request run, and no other credential is available to do it.
interface RequiredPermission {
  name: string;
  level: "read" | "write";
  why: string;
}

const REQUIRED_PERMISSIONS: RequiredPermission[] = [
  { name: "administration", level: "read", why: "inspect classic branch protection" },
  { name: "contents", level: "write", why: "push the reviewed commit" },
  { name: "pull_requests", level: "write", why: "open, comment on and merge pull requests" },
  { name: "issues", level: "write", why: "post on the pull request conversation" },
  { name: "metadata", level: "read", why: "read the repository" },
  { name: "checks", level: "read", why: "read CI check runs while polling pull requests" },
  { name: "statuses", level: "read", why: "read CI commit statuses while polling pull requests" },
  { name: "repository_hooks", level: "write", why: "create the webhook that wakes parked runs" },
];

const JIGS_MERGE_PERMISSIONS: RequiredPermission[] = [
  { name: "actions", level: "read", why: "detect whether the repository has CI workflows" },
];

const SATISFIES: Record<string, string[]> = { read: ["read", "write"], write: ["write"] };

export interface GithubIdentityProbes {
  whoami(): Promise<{ login: string }>;
  readPrivateKey(file: string): ReturnType<typeof readAppPrivateKey>;
  installation(
    identity: AppIdentity,
    key: string,
  ): Promise<{ permissions: Record<string, string> }>;
  registration(identity: AppIdentity, key: string): Promise<{ slug: string }>;
}

export const realGithubIdentityProbes = (
  whoami: () => Promise<{ login: string }>,
): GithubIdentityProbes => ({
  whoami,
  readPrivateKey: readAppPrivateKey,
  installation: (identity, key) => fetchAppInstallation(identity, key),
  registration: (identity, key) => fetchAppRegistration(identity, key),
});

export interface GithubMergePolicyProbes {
  repository(
    owner: string,
    repo: string,
  ): Promise<{
    default_branch: string;
    permissions?: { admin?: boolean };
    allow_merge_commit?: boolean;
    allow_squash_merge?: boolean;
    allow_rebase_merge?: boolean;
  }>;
  checkRuns(owner: string, repo: string, ref: string): Promise<number>;
  commitStatuses(owner: string, repo: string, ref: string): Promise<number>;
  actionsWorkflows(owner: string, repo: string): Promise<number>;
  labelExists(owner: string, repo: string, label: string): Promise<boolean>;
  protection(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<{
    requiredStatusChecks: number;
    requiredApprovingReviews: number;
    /** False when one protection mechanism could not be read. */
    complete?: boolean;
  } | null>;
}

export const realGithubMergePolicyProbes: GithubMergePolicyProbes = {
  repository: (owner, repo) => githubGet(`/repos/${owner}/${repo}`),
  checkRuns: async (owner, repo, ref) =>
    (
      await githubGet<{ total_count: number }>(
        `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=1`,
      )
    ).total_count,
  commitStatuses: async (owner, repo, ref) =>
    (
      await githubGet<{ total_count: number }>(
        `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/status?per_page=1`,
      )
    ).total_count,
  actionsWorkflows: async (owner, repo) => {
    let active = 0;
    for (let page = 1; page <= 50; page += 1) {
      const result = await githubGet<{
        total_count: number;
        workflows: Array<{ state: string }>;
      }>(`/repos/${owner}/${repo}/actions/workflows?per_page=100&page=${page}`);
      active += result.workflows.filter((workflow) => workflow.state === "active").length;
      if (result.workflows.length < 100 || page * 100 >= result.total_count) return active;
    }
    return active;
  },
  labelExists: async (owner, repo, label) => {
    try {
      await githubGet(`/repos/${owner}/${repo}/labels/${encodeURIComponent(label)}`);
      return true;
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 404) return false;
      throw err;
    }
  },
  protection: async (owner, repo, branch) => {
    const base = `/repos/${owner}/${repo}`;
    const encodedBranch = encodeURIComponent(branch);
    const [classic, rules] = await Promise.allSettled([
      githubGet<{
        required_status_checks?: {
          contexts?: string[];
          checks?: Array<{ context: string }>;
        } | null;
        required_pull_request_reviews?: { required_approving_review_count?: number } | null;
      }>(`${base}/branches/${encodedBranch}/protection`),
      githubGet<
        Array<{
          type: string;
          parameters?: {
            required_approving_review_count?: number;
            required_status_checks?: Array<{ context?: string }>;
          };
        }>
      >(`${base}/rules/branches/${encodedBranch}`),
    ]);
    if (classic.status === "rejected" && rules.status === "rejected") {
      throw new AggregateError(
        [classic.reason, rules.reason],
        `could not read classic protection or rulesets for ${owner}/${repo}`,
      );
    }
    const classicValue = settledValue(classic);
    const ruleValues = settledValue(rules) ?? [];
    const statusRules = ruleValues.filter((rule) => rule.type === "required_status_checks");
    const reviewRules = ruleValues.filter((rule) => rule.type === "pull_request");
    const complete = classic.status === "fulfilled" && rules.status === "fulfilled";
    if (
      complete &&
      classicValue === undefined &&
      statusRules.length === 0 &&
      reviewRules.length === 0
    ) {
      return null;
    }
    const requiredChecks = new Set([
      ...(classicValue?.required_status_checks?.contexts ?? []),
      ...(classicValue?.required_status_checks?.checks ?? []).map((check) => check.context),
      ...statusRules.flatMap((rule) =>
        (rule.parameters?.required_status_checks ?? []).flatMap((check) =>
          check.context === undefined ? [] : [check.context],
        ),
      ),
    ]);
    return {
      requiredStatusChecks: requiredChecks.size,
      requiredApprovingReviews: Math.max(
        classicValue?.required_pull_request_reviews?.required_approving_review_count ?? 0,
        ...reviewRules.map((rule) => rule.parameters?.required_approving_review_count ?? 0),
      ),
      complete,
    };
  },
};

/** The identity check for the configured mode, plus the effective merge policy. */
export function githubIdentityChecks(
  identity: GithubIdentity,
  merge: MergePolicy,
  probes: GithubIdentityProbes,
  env: NodeJS.ProcessEnv = process.env,
  bindings: Record<string, Pick<BindingEntry, "remote" | "merge">> = {},
  mergeProbes: GithubMergePolicyProbes = realGithubMergePolicyProbes,
): Check[] {
  const checksBindingPolicies = Object.values(bindings).some(
    (binding) => bindingMergePolicy(merge, binding).by === "jigs",
  );
  return [
    identity.mode === "pat"
      ? patCheck(probes, env)
      : appCheck(identity, checksBindingPolicies, probes),
    mergePolicyCheck(identity, merge, bindings, mergeProbes),
  ];
}

function patCheck(probes: GithubIdentityProbes, env: NodeJS.ProcessEnv): Check {
  return {
    id: "github.identity",
    label: "GitHub identity",
    run: async (): Promise<CheckResult> => {
      const token = env.GITHUB_TOKEN;
      if (token === undefined || token === "") {
        return {
          ok: false,
          reason: "github.identity is pat but GITHUB_TOKEN is not set in the service's environment",
          repair: `set GITHUB_TOKEN in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`,
        };
      }
      try {
        const { login } = await probes.whoami();
        return { ok: true, detail: `jigs acts as ${login}` };
      } catch (err) {
        return {
          ok: false,
          reason: `GITHUB_TOKEN is set but GitHub rejected it: ${err}`,
          repair: `re-issue the token and update GITHUB_TOKEN in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`,
        };
      }
    },
  };
}

function appCheck(
  identity: AppIdentity,
  checksBindingPolicies: boolean,
  probes: GithubIdentityProbes,
): Check {
  return {
    id: "github.identity",
    label: "GitHub identity",
    run: async (): Promise<CheckResult> => {
      let key: string;
      let looseMode: string | undefined;
      try {
        ({ key, looseMode } = probes.readPrivateKey(identity.privateKeyPath));
      } catch (err) {
        return {
          ok: false,
          reason: String(err),
          repair: `download the App's private key, point github.identity.privateKeyPath at it, and: chmod 600 ${identity.privateKeyPath}`,
        };
      }
      // Before any network call: a key anyone can read is a credential to
      // rotate, and probing with it first would only widen the window.
      if (looseMode !== undefined) {
        return {
          ok: false,
          reason: `${identity.privateKeyPath} is mode ${looseMode} — anyone on this machine can act as the App`,
          repair: `chmod 600 ${identity.privateKeyPath}`,
        };
      }
      let permissions: Record<string, string>;
      let slug: string;
      try {
        // Both mint a JWT from the key, so a key the App does not recognise
        // and an installation that is gone are distinguished by the message.
        [{ permissions }, { slug }] = await Promise.all([
          probes.installation(identity, key),
          probes.registration(identity, key),
        ]);
      } catch (err) {
        return {
          ok: false,
          reason: `App ${identity.appId} installation ${identity.installationId} did not answer: ${err}`,
          repair:
            "check github.identity.appId and installationId against the App's settings page and its installation, and that the private key belongs to that App",
        };
      }
      const requiredPermissions = [
        ...REQUIRED_PERMISSIONS,
        ...(checksBindingPolicies ? JIGS_MERGE_PERMISSIONS : []),
      ];
      const missing = requiredPermissions.filter(
        (required) =>
          !(SATISFIES[required.level] ?? []).includes(permissions[required.name] ?? "none"),
      );
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `the installation is missing ${missing.map((p) => `${p.name}: ${p.level} (to ${p.why})`).join(", ")}`,
          repair:
            "grant the permission on the App (Settings → Developer settings → GitHub Apps → Permissions — “Repository webhooks” is Read & write), then accept the updated permissions on the installation",
        };
      }
      return { ok: true, detail: `jigs acts as ${slug}[bot]; operator ${identity.operator}` };
    },
  };
}

// The effective policy per binding, plus repository facts that make one impossible.
export function mergePolicyCheck(
  identity: GithubIdentity,
  merge: MergePolicy,
  bindings: Record<string, Pick<BindingEntry, "remote" | "merge">>,
  probes: GithubMergePolicyProbes,
  probeTimeoutMs: number = PROBE_TIMEOUT_MS,
): Check {
  const entries = Object.entries(bindings);
  const policies = entries.map(
    ([name, binding]) => [name, bindingMergePolicy(merge, binding)] as const,
  );
  const detail =
    policies.length === 0
      ? describeMergePolicy(merge)
      : policies.map(([name, policy]) => `${name}: ${describeMergePolicy(policy)}`).join("; ");
  return {
    id: "github.merge-policy",
    label: "merge policy",
    run: async (): Promise<CheckResult> => {
      const inspections = await Promise.allSettled(
        entries.map(([name, binding]) => {
          const policy = bindingMergePolicy(merge, binding);
          return policy.by === "jigs"
            ? inspectBindingWithin(name, binding, identity, policy, probes, probeTimeoutMs)
            : [];
        }),
      );
      const findings = inspections.flatMap((inspection) =>
        inspection.status === "fulfilled" ? inspection.value : [],
      );
      if (findings.length === 0) return { ok: true, detail };
      return {
        ok: false,
        reason: `${detail}; ${findings.map((finding) => `${finding.binding}: ${finding.reason}`).join("; ")}`,
        repair: findings.map((finding) => `${finding.binding}: ${finding.repair}`).join("; "),
      };
    },
  };
}

function describeMergePolicy(merge: MergePolicy): string {
  const signal =
    merge.approval.kind === "review"
      ? "an approving GitHub review of the current commit"
      : `the ${merge.approval.name} label`;
  return merge.by === "jigs"
    ? `jigs merges with ${merge.method} once GitHub reports it mergeable and ${signal} is present`
    : `a human merges; jigs only watches (${signal} would be the signal if merge.by were jigs)`;
}

async function inspectBindingWithin(
  bindingName: string,
  binding: Pick<BindingEntry, "remote">,
  identity: GithubIdentity,
  merge: MergePolicy,
  probes: GithubMergePolicyProbes,
  timeoutMs: number,
): Promise<PolicyFinding[]> {
  const timeout = new Promise<PolicyFinding[]>((resolve) => {
    AbortSignal.timeout(timeoutMs).addEventListener("abort", () => resolve([]), { once: true });
  });
  return Promise.race([inspectBinding(bindingName, binding, identity, merge, probes), timeout]);
}

interface PolicyFinding {
  binding: string;
  reason: string;
  repair: string;
}

async function inspectBinding(
  bindingName: string,
  binding: Pick<BindingEntry, "remote">,
  identity: GithubIdentity,
  merge: MergePolicy,
  probes: GithubMergePolicyProbes,
): Promise<PolicyFinding[]> {
  const ref = parseGithubRemote(binding.remote);
  if (ref === null) return [];
  let repository: Awaited<ReturnType<GithubMergePolicyProbes["repository"]>>;
  try {
    repository = await probes.repository(ref.owner, ref.repo);
  } catch {
    // A missing/inaccessible repo is diagnosed by bind's webhook leg and by
    // the webhook doctor check. It does not provide enough evidence for a
    // merge-policy repair, and may simply be a transient/rate-limit failure.
    return [];
  }
  const [checkRunsResult, commitStatusesResult, actionsWorkflowsResult] = await Promise.allSettled([
    probes.checkRuns(ref.owner, ref.repo, repository.default_branch),
    probes.commitStatuses(ref.owner, ref.repo, repository.default_branch),
    probes.actionsWorkflows(ref.owner, ref.repo),
  ]);
  const findings: PolicyFinding[] = [];
  const [protectionSettled] = await Promise.allSettled([
    probes.protection(ref.owner, ref.repo, repository.default_branch),
  ]);
  const protectionResult = settledValue(protectionSettled);
  const incompleteCouldChangeVerdict =
    protectionResult !== null &&
    protectionResult !== undefined &&
    protectionResult.complete === false &&
    (protectionResult.requiredStatusChecks === 0 ||
      merge.approval.kind === "label" ||
      protectionResult.requiredApprovingReviews === 0);
  if (protectionSettled.status === "rejected" || incompleteCouldChangeVerdict) {
    findings.push({
      binding: bindingName,
      reason: `could not read branch protection or rulesets for ${ref.owner}/${ref.repo}, so jigs cannot verify that merges will be allowed`,
      repair:
        identity.mode === "app"
          ? "grant the GitHub App Administration: read in Settings → Developer settings → GitHub Apps, then accept the updated installation permissions"
          : "replace GITHUB_TOKEN with a PAT that has repository administration access so it can read branch protection, then restart the jigs service",
    });
  } else if (protectionResult === null) {
    findings.push({
      binding: bindingName,
      reason: `${ref.owner}/${ref.repo}'s default branch has no classic branch protection or ruleset requiring CI`,
      repair: `in ${ref.owner}/${ref.repo} Settings → Branches or Rules → Rulesets, add a rule for the default branch that requires the repository's CI checks before merge`,
    });
  } else if (protectionResult !== undefined) {
    if (protectionResult.requiredStatusChecks === 0)
      findings.push({
        binding: bindingName,
        reason: `${ref.owner}/${ref.repo}'s default branch does not require CI checks, so jigs could merge a change whose CI failed`,
        repair: `in ${ref.owner}/${ref.repo} Settings → Branches or Rules → Rulesets, require the repository's CI checks before merge`,
      });
    if (merge.approval.kind === "review" && protectionResult.requiredApprovingReviews < 1)
      findings.push({
        binding: bindingName,
        reason: `${ref.owner}/${ref.repo}'s default branch does not require an approving review, so GitHub does not enforce the approval signal jigs is configured to use`,
        repair: `in ${ref.owner}/${ref.repo} Settings → Branches or Rules → Rulesets, require at least one approving review, or change this factory's approval to label`,
      });
  }
  const allowed = {
    merge: repository.allow_merge_commit,
    squash: repository.allow_squash_merge,
    rebase: repository.allow_rebase_merge,
  }[merge.method];
  if (allowed === false)
    findings.push({
      binding: bindingName,
      reason: `${merge.method} merges are disabled on ${ref.owner}/${ref.repo}, so GitHub will refuse the merge method jigs is configured to use`,
      repair: `enable ${merge.method} merges in ${ref.owner}/${ref.repo} Settings → General → Pull Requests, or set bindings.${bindingName}.merge.method in jigs.config.ts to an enabled method`,
    });
  const checkRunCount = settledValue(checkRunsResult);
  const statusCount = settledValue(commitStatusesResult);
  const workflowCount = settledValue(actionsWorkflowsResult);
  if (checkRunCount === 0 && statusCount === 0 && workflowCount === 0)
    findings.push({
      binding: bindingName,
      reason: `${ref.owner}/${ref.repo} has no active Actions workflows and its default branch has no check runs or commit statuses, so jigs has no CI result to wait for before merging`,
      repair: `add and run a CI workflow on the default branch, or set bindings.${bindingName}.merge.by to "human" in jigs.config.ts`,
    });
  if (merge.approval.kind === "label") {
    const [labelExistsResult] = await Promise.allSettled([
      probes.labelExists(ref.owner, ref.repo, merge.approval.name),
    ]);
    if (settledValue(labelExistsResult) === false)
      findings.push({
        binding: bindingName,
        reason: `${ref.owner}/${ref.repo} has no ${merge.approval.name} label, so the configured approval signal can never be given`,
        repair: `create the ${merge.approval.name} label in ${ref.owner}/${ref.repo} Issues → Labels, re-run jigs bind to restore it, or switch this factory's approval to review`,
      });
    const approvals = protectionResult?.requiredApprovingReviews;
    if (approvals !== undefined && approvals > 0)
      findings.push({
        binding: bindingName,
        reason: `${ref.owner}/${ref.repo} requires ${approvals} approving review${approvals === 1 ? "" : "s"} before merge, but this factory approves with a label, which GitHub will not count`,
        repair: `remove the required-review rule in ${ref.owner}/${ref.repo} Settings → Branches or Rules → Rulesets, or switch this factory's approval to review`,
      });
  }
  return findings;
}

function settledValue<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === "fulfilled" ? result.value : undefined;
}
