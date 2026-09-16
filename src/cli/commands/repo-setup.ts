import { bindingMergePolicy, readFactoryConfig } from "../../config/factory-config.ts";
import { locateFactoryRoot } from "../../config/factory-root.ts";
import { JigsError } from "../../errors.ts";
import { resolveGithubIdentity, useFactoryRoot } from "../../providers/github-auth.ts";
import {
  type BranchProtection,
  defaultBranch,
  type GithubBranchProtection,
  getBranchProtection,
  observedChecks,
  putBranchProtection,
} from "../../providers/github-branch-protection.ts";
import { parseGithubRemote } from "../../providers/github-webhook.ts";

export interface RepoSetupDeps {
  cwd: string;
  out: (line: string) => void;
  confirm?: (question: string) => Promise<boolean>;
  protection?: {
    defaultBranch(owner: string, repo: string): Promise<string>;
    get(owner: string, repo: string, branch: string): Promise<GithubBranchProtection>;
    observedChecks(owner: string, repo: string, branch: string): Promise<string[]>;
    put(
      owner: string,
      repo: string,
      branch: string,
      current: GithubBranchProtection,
      desired: BranchProtection,
    ): Promise<void>;
  };
}

export interface RepoSetupOptions {
  yes?: boolean;
}

export type RepoSetupResult = "applied" | "already-set" | "declined";

const realProtection: NonNullable<RepoSetupDeps["protection"]> = {
  defaultBranch: (owner, repo) => defaultBranch({ owner, repo }),
  get: (owner, repo, branch) => getBranchProtection({ owner, repo }, branch),
  observedChecks: (owner, repo, branch) => observedChecks({ owner, repo }, branch),
  put: (owner, repo, branch, current, desired) =>
    putBranchProtection({ owner, repo }, branch, current, desired),
};

export async function setupRepo(
  bindingName: string,
  deps: RepoSetupDeps,
  options: RepoSetupOptions = {},
): Promise<RepoSetupResult> {
  const factoryRoot = locateFactoryRoot(deps.cwd);
  useFactoryRoot(factoryRoot);
  const config = readFactoryConfig(factoryRoot);
  const binding = config.bindings[bindingName];
  if (binding === undefined)
    throw new JigsError(`no binding named ${bindingName} in jigs.config.ts`);
  const repo = parseGithubRemote(binding.remote);
  if (repo === null) {
    throw new JigsError(
      `${bindingName} is not a github.com binding`,
      "repo setup manages GitHub repositories",
    );
  }

  const identity = resolveGithubIdentity(factoryRoot);
  const merge = bindingMergePolicy(config.merge, binding);
  const protection = deps.protection ?? realProtection;
  const branch = await protection.defaultBranch(repo.owner, repo.repo);
  const current = await protection.get(repo.owner, repo.repo, branch);
  const requiredChecks =
    current.requiredChecks.length > 0
      ? current.requiredChecks
      : await protection.observedChecks(repo.owner, repo.repo, branch);
  if (requiredChecks.length === 0) {
    throw new JigsError(
      `cannot require status checks on ${repo.owner}/${repo.repo}:${branch}: no checks or commit statuses were found`,
      `run CI on the default branch, then re-run: jigs repo setup ${bindingName}`,
    );
  }

  const reviews = identity.mode === "app" ? 1 : 0;
  const desired: BranchProtection = {
    protected: true,
    requiredChecks,
    requiredCheckApps: current.requiredCheckApps,
    strictChecks: current.strictChecks,
    requiredApprovingReviews: reviews,
  };
  const changes = diff(current, desired);
  deps.out(`repository rules for ${repo.owner}/${repo.repo}:${branch}`);
  deps.out(
    `  status checks: require ${requiredChecks.join(", ")} — prevents merging before CI passes`,
  );
  deps.out("  branch protection — prevents direct, ungoverned changes to the default branch");
  if (reviews === 1) {
    deps.out("  approving reviews: require 1 — a human approves pull requests authored by the App");
  } else if (identity.mode === "pat" && merge.approval.kind === "label") {
    deps.out(
      `  approving reviews: require 0 — refusing a required-review rule because the ${merge.approval.name} label cannot satisfy it; jigs-authored pull requests would stay blocked forever`,
    );
  } else {
    deps.out(
      "  approving reviews: require 0 — the effective approval signal is not a GitHub review",
    );
  }
  if (changes.length === 0) {
    deps.out("already set; no repository rules changed");
    return "already-set";
  }
  deps.out("changes:");
  for (const change of changes) deps.out(`  ${change}`);

  if (!options.yes) {
    if (deps.confirm === undefined) {
      throw new JigsError(
        "repo setup needs an interactive terminal before it can write repository rules",
        `re-run interactively, or apply this plan unattended with: jigs repo setup ${bindingName} --yes`,
      );
    }
    if (!(await deps.confirm("Apply these repository rules?"))) {
      deps.out("not applied");
      return "declined";
    }
  }
  await protection.put(repo.owner, repo.repo, branch, current, desired);
  deps.out("applied repository rules");
  return "applied";
}

function diff(current: BranchProtection, desired: BranchProtection): string[] {
  const changes: string[] = [];
  if (!current.protected) changes.push("+ protect the default branch");
  if (current.requiredChecks.join("\0") !== desired.requiredChecks.join("\0")) {
    changes.push(
      `${current.requiredChecks.length === 0 ? "+" : "~"} required status checks: ${desired.requiredChecks.join(", ")}`,
    );
  }
  if (current.requiredApprovingReviews !== desired.requiredApprovingReviews) {
    changes.push(
      `~ required approving reviews: ${current.requiredApprovingReviews} → ${desired.requiredApprovingReviews}`,
    );
  }
  return changes;
}
