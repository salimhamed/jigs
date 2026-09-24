// Which GitHub identity this factory runs as, and whether that credential
// actually works. The two modes fail in completely different ways — a rejected
// token versus an App whose key, installation or permissions are wrong — so
// each gets its own checks and its own repair.

import type { MergePolicy } from "../blocks/pull-requests/policy.ts";
import {
  type AppIdentity,
  type BindingEntry,
  bindingMergePolicy,
  type GithubIdentity,
  type ResolvedAppIdentity,
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

// What jigs needs of an installation, and why.
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
];

// Only with GitHub webhooks on, and then the one operators miss: `jigs bind`
// creates the per-repo webhook, and no other credential can do it.
const WEBHOOK_PERMISSIONS: RequiredPermission[] = [
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
    identity: ResolvedAppIdentity,
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
    allow_merge_commit?: boolean;
    allow_squash_merge?: boolean;
    allow_rebase_merge?: boolean;
  }>;
  checkRuns(owner: string, repo: string, ref: string): Promise<number>;
  commitStatuses(owner: string, repo: string, ref: string): Promise<number>;
  actionsWorkflows(owner: string, repo: string): Promise<number>;
  labelExists(owner: string, repo: string, label: string): Promise<boolean>;
  protection(owner: string, repo: string, branch: string): Promise<ProtectionReading | null>;
}

/** Which protection mechanism GitHub refused to show, when the other answered. */
type ProtectionGap = "classic" | "rulesets";

export interface ProtectionReading {
  requiredApprovingReviews: number;
  unread: ProtectionGap | null;
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
        required_pull_request_reviews?: { required_approving_review_count?: number } | null;
      }>(`${base}/branches/${encodedBranch}/protection`),
      githubGet<
        Array<{
          type: string;
          parameters?: { required_approving_review_count?: number };
        }>
      >(`${base}/rules/branches/${encodedBranch}`),
    ]);
    // GitHub answers 404 on the classic endpoint when the branch carries no
    // classic protection. That is an answer, not a permission problem.
    const classicUnprotected = classic.status === "rejected" && isNotFound(classic.reason);
    if (classic.status === "rejected" && !classicUnprotected && rules.status === "rejected") {
      throw new AggregateError(
        [classic.reason, rules.reason],
        `could not read classic protection or rulesets for ${owner}/${repo}`,
      );
    }
    const classicValue = settledValue(classic);
    const ruleValues = settledValue(rules) ?? [];
    const statusRules = ruleValues.filter((rule) => rule.type === "required_status_checks");
    const reviewRules = ruleValues.filter((rule) => rule.type === "pull_request");
    const unread: ProtectionGap | null =
      classic.status === "rejected" && !classicUnprotected
        ? "classic"
        : rules.status === "rejected"
          ? "rulesets"
          : null;
    if (
      unread === null &&
      classicValue === undefined &&
      statusRules.length === 0 &&
      reviewRules.length === 0
    ) {
      return null;
    }
    return {
      requiredApprovingReviews: Math.max(
        classicValue?.required_pull_request_reviews?.required_approving_review_count ?? 0,
        ...reviewRules.map((rule) => rule.parameters?.required_approving_review_count ?? 0),
      ),
      unread,
    };
  },
};

const isNotFound = (err: unknown) => err instanceof GithubApiError && err.status === 404;

/** What else the identity checks need to know about the factory. */
export interface GithubIdentityCheckOptions {
  bindings?: Record<string, Pick<BindingEntry, "remote" | "merge">>;
  /** Whether GitHub webhooks are on, which makes an App need hook administration. */
  webhooks?: boolean;
  mergeProbes?: GithubMergePolicyProbes;
}

/** The identity check for the configured mode, plus the effective merge policy. */
export function githubIdentityChecks(
  identities: GithubIdentity[],
  merge: MergePolicy,
  probes: GithubIdentityProbes,
  env: NodeJS.ProcessEnv = process.env,
  {
    bindings = {},
    webhooks = false,
    mergeProbes = realGithubMergePolicyProbes,
  }: GithubIdentityCheckOptions = {},
): Check[] {
  const primary = identities[0];
  if (!primary) throw new Error("GitHub identity checks require a nonempty normalized list");
  const checksBindingPolicies = Object.values(bindings).some(
    (binding) => bindingMergePolicy(merge, binding).by === "jigs",
  );
  const registrations = new Map<number, Promise<{ slug: string }>>();
  const appProbes: GithubIdentityProbes = {
    ...probes,
    registration: (entry, key) => {
      let pending = registrations.get(entry.appId);
      if (!pending) {
        pending = probes.registration(entry, key);
        registrations.set(entry.appId, pending);
      }
      return pending;
    },
  };
  return [
    ...identities.map((entry, index) => {
      const check =
        entry.mode === "pat"
          ? patCheck(probes, env)
          : appCheck(entry, checksBindingPolicies, webhooks, appProbes);
      return identities.length === 1
        ? check
        : { ...check, id: `github.identity.${index}`, label: `GitHub identity ${index + 1}` };
    }),
    mergePolicyCheck(primary, merge, bindings, mergeProbes),
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
          reason:
            "github.identities uses pat but GITHUB_TOKEN is not set in the service's environment",
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
  webhooks: boolean,
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
          repair: `download App ${identity.appId}’s private key, set privateKeyPath in that App’s entry in jigs.config.ts, and: chmod 600 ${identity.privateKeyPath}`,
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
      const { installations: accountInstallations, ...app } = identity;
      const installationIds = Object.values(accountInstallations);
      let installations: Array<{ installationId: number; permissions: Record<string, string> }>;
      let slug: string;
      try {
        // Both mint a JWT from the key, so a key the App does not recognise
        // and an installation that is gone are distinguished by the message.
        [installations, { slug }] = await Promise.all([
          Promise.all(
            installationIds.map(async (installationId) => {
              try {
                return {
                  installationId,
                  ...(await probes.installation({ ...app, installationId }, key)),
                };
              } catch (err) {
                throw new Error(`installation ${installationId}: ${err}`);
              }
            }),
          ),
          probes.registration(identity, key),
        ]);
      } catch (err) {
        return {
          ok: false,
          reason: `App ${identity.appId} installation ${installationIds.join(", ")} did not answer: ${err}`,
          repair:
            "check the App entry’s appId and installations against the App's settings page and its installation, and that the private key belongs to that App",
        };
      }
      const requiredPermissions = [
        ...REQUIRED_PERMISSIONS,
        ...(checksBindingPolicies ? JIGS_MERGE_PERMISSIONS : []),
        ...(webhooks ? WEBHOOK_PERMISSIONS : []),
      ];
      const missing = installations.flatMap(({ installationId, permissions }) =>
        requiredPermissions
          .filter(
            (required) =>
              !(SATISFIES[required.level] ?? []).includes(permissions[required.name] ?? "none"),
          )
          .map((permission) => ({
            ...permission,
            installationId,
          })),
      );
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `the installation is missing ${missing.map((p) => `${p.name}: ${p.level} (to ${p.why}; installation ${p.installationId})`).join(", ")}`,
          repair: `grant the permission on the App (Settings → Developer settings → GitHub Apps → Permissions${missing.some((p) => p.name === "repository_hooks") ? " — “Repository webhooks” is Read & write" : ""}), then accept the updated permissions on the installation`,
        };
      }
      return {
        ok: true,
        detail: `jigs acts as ${slug}[bot] on ${Object.keys(identity.installations).join(", ")}; operator ${identity.operator}`,
      };
    },
  };
}

// The effective policy per binding, plus repository facts that make one impossible.
export function mergePolicyCheck(
  identity: Pick<GithubIdentity, "mode">,
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
  identity: Pick<GithubIdentity, "mode">,
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
  identity: Pick<GithubIdentity, "mode">,
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
  const unread: ProtectionGap | "both" | null =
    protectionSettled.status === "rejected" ? "both" : (protectionResult?.unread ?? null);
  // Only label approval reads protection, so only it is left open by a gap.
  if (unread !== null && merge.approval.kind === "label")
    findings.push({ binding: bindingName, ...unreadableProtection(unread, ref, identity) });
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
        repair: `create the ${merge.approval.name} label in ${ref.owner}/${ref.repo} Issues → Labels, re-run pnpm exec jigs bind to restore it, or switch this factory's approval to review`,
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

// Each gap has its own repair: only classic branch protection needs
// administration rights, so pointing at permissions for a failed ruleset read
// would send an operator after a permission that is already enough.
function unreadableProtection(
  unread: ProtectionGap | "both",
  ref: { owner: string; repo: string },
  identity: Pick<GithubIdentity, "mode">,
): Omit<PolicyFinding, "binding"> {
  const slug = `${ref.owner}/${ref.repo}`;
  const cannotVerify = "so jigs cannot verify that merges will be allowed";
  const grantAdministration =
    identity.mode === "app"
      ? "grant the GitHub App Administration: read in Settings → Developer settings → GitHub Apps, then accept the updated installation permissions"
      : "replace GITHUB_TOKEN with a PAT that has repository administration access so it can read branch protection, then restart the jigs service";
  if (unread === "rulesets")
    return {
      reason: `read ${slug}'s classic branch protection but not its rulesets, ${cannotVerify}`,
      repair: `reading rulesets needs no extra permission, so GitHub did not answer: re-run pnpm exec jigs doctor, and if it keeps failing check GitHub's status and that ${slug} is still reachable`,
    };
  return {
    reason:
      unread === "classic"
        ? `read ${slug}'s rulesets but not its classic branch protection, ${cannotVerify}`
        : `could not read branch protection or rulesets for ${slug}, ${cannotVerify}`,
    repair: grantAdministration,
  };
}

function settledValue<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === "fulfilled" ? result.value : undefined;
}
