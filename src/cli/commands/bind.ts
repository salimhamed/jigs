import { existsSync } from "node:fs";
import path from "node:path";
import { formatFailures, runChecks } from "../../checks/catalog.ts";
import {
  type GithubMergePolicyProbes,
  mergePolicyCheck,
  realGithubMergePolicyProbes,
} from "../../checks/github-identity.ts";
import { upsertBinding } from "../../config/binding-edit.ts";
import {
  bindingMergePolicy,
  installationFor,
  readFactoryConfig,
  readFactoryConfigText,
  writeFactoryConfigText,
} from "../../config/factory-config.ts";
import { factoryEnvValue, readFactoryEnv } from "../../config/factory-env.ts";
import { locateFactoryRoot } from "../../config/factory-root.ts";
import {
  githubWebhookSecret,
  githubWebhookSecretRepair,
  missingGithubWebhookSecret,
} from "../../config/github-webhook-secret.ts";
import { JigsError } from "../../errors.ts";
import { GithubApiError } from "../../providers/github-api.ts";
import { resolveGithubIdentity, useFactoryRoot } from "../../providers/github-auth.ts";
import { type EnsureRepoLabelOptions, ensureRepoLabel } from "../../providers/github-label.ts";
import { ensureRepoWebhook, parseGithubRemote } from "../../providers/github-webhook.ts";
import { hasBindingClone } from "../../steps/workspaces/clone.ts";
import { bindingDir, bindingRepoDir } from "../../steps/workspaces/layout.ts";

const BINDING_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface BindDeps {
  cwd: string;
  out: (line: string) => void;
  mergePolicyProbes?: GithubMergePolicyProbes;
  ensureLabel?: (options: EnsureRepoLabelOptions) => Promise<"created" | "verified">;
}

export interface BindOptions {
  name?: string;
}

export interface BindResult {
  name: string;
  remote: string;
  webhook: "created" | "verified" | "updated" | "skipped";
}

// A config edit plus jigs-owned repository furniture: the webhook and approval
// label legs may write, while merge-policy inspection is read-only and
// non-fatal. The clone is the service's to make at its next start.
export async function bindRepo(
  remoteUrl: string,
  deps: BindDeps,
  options: BindOptions = {},
): Promise<BindResult> {
  const factoryRoot = locateFactoryRoot(deps.cwd);
  // The GitHub credential belongs to the factory this verb was typed in, which
  // need not be the one the process's own directory sits in.
  useFactoryRoot(factoryRoot);
  // The remote is handed to git in positional slots for the life of the
  // binding, so a leading dash is refused once, here, rather than defended
  // against at every call site.
  if (remoteUrl.startsWith("-")) {
    throw new JigsError(
      `${remoteUrl} starts with a dash — bind takes a remote URL, not a git option`,
      "jigs bind git@github.com:owner/repo.git",
    );
  }
  if (looksLikePath(remoteUrl)) {
    throw new JigsError(
      `${remoteUrl} looks like a path — bind takes a remote URL`,
      "jigs bind git@github.com:owner/repo.git — a repo on this machine is a URL too: file:///srv/git/repo.git",
    );
  }

  const config = readFactoryConfig(factoryRoot);
  const account = parseGithubRemote(remoteUrl)?.owner;
  if (account) installationFor(config.github.identities, account);
  const matchingBindings = Object.entries(config.bindings).filter(
    ([, binding]) => binding.remote === remoteUrl,
  );
  const matchingBinding = matchingBindings[0];
  const derivedName = defaultBindingName(remoteUrl);
  const name = options.name ?? matchingBinding?.[0] ?? derivedName;
  if (!BINDING_NAME_PATTERN.test(name)) {
    throw new JigsError(
      `invalid binding name ${JSON.stringify(name)}`,
      "names must match [A-Za-z0-9][A-Za-z0-9._-]* — pass --binding-name to choose one",
    );
  }

  const text = readFactoryConfigText(factoryRoot);
  const existing = Object.hasOwn(config.bindings, name) ? config.bindings[name] : undefined;
  if (existing !== undefined && existing.remote !== remoteUrl) {
    // Repointing silently would fetch an unrelated history into an object
    // store that already holds another repo's.
    throw new JigsError(
      `${name} is already bound to ${existing.remote}`,
      `jigs unbind ${name}, then bind again — the clone at ${bindingDir({ factoryRoot, bindingName: name })} holds the old repo's objects`,
    );
  }
  const updated = upsertBinding(text, name, remoteUrl);

  if (updated !== text) {
    writeFactoryConfigText(factoryRoot, updated);
  }
  deps.out(
    existing === undefined
      ? `bound ${name} → ${remoteUrl}`
      : `${name} already points at ${remoteUrl}`,
  );
  // A new entry has nothing cloned yet, or — after the unbind a repoint takes
  // — the old repo's objects sitting where its clone goes. An entry a failed
  // webhook leg already wrote owes the clone as much on the re-run.
  if (
    existing === undefined ||
    !hasBindingClone(bindingRepoDir({ factoryRoot, bindingName: name }))
  ) {
    deps.out(`run jigs up to apply the config and clone ${name}`);
  }

  // Last, so furniture that cannot be ensured leaves the binding recorded and
  // the whole verb re-runnable: the config edit above and both operations below
  // are idempotent. Ensure the webhook first because it wakes every run; label
  // approval is only one possible merge signal.
  const reBindCommand =
    options.name !== undefined || name !== derivedName
      ? `jigs bind ${remoteUrl} --binding-name ${name}`
      : `jigs bind ${remoteUrl}`;
  const webhook = await ensureWebhook({
    remoteUrl,
    factoryRoot,
    ingressUrl: config.ingressUrl,
    // The repair it prints has to land on this binding, not on the one the
    // remote alone would derive.
    reBindCommand,
    deps,
  });
  const binding = {
    remote: remoteUrl,
    ...(existing?.merge ? { merge: existing.merge } : {}),
  };
  await ensureApprovalLabel(
    remoteUrl,
    bindingMergePolicy(config.merge, binding).approval,
    factoryRoot,
    reBindCommand,
    deps,
  );
  const report = await runChecks([
    mergePolicyCheck(
      resolveGithubIdentity(account ?? "", factoryRoot),
      config.merge,
      { [name]: binding },
      deps.mergePolicyProbes ?? realGithubMergePolicyProbes,
    ),
  ]);
  if (!report.ok) deps.out(formatFailures(report));
  return { name, remote: remoteUrl, webhook };
}

async function ensureApprovalLabel(
  remoteUrl: string,
  approval: ReturnType<typeof readFactoryConfig>["merge"]["approval"],
  factoryRoot: string,
  reBindCommand: string,
  deps: BindDeps,
): Promise<void> {
  if (approval.kind !== "label") return;
  const repoRef = parseGithubRemote(remoteUrl);
  if (repoRef === null) {
    deps.out(`note: skipping approval label (${remoteUrl} is not a github.com remote)`);
    return;
  }
  const slug = `${repoRef.owner}/${repoRef.repo}`;
  const identity = resolveGithubIdentity(repoRef.owner, factoryRoot);
  const credentialRepair =
    identity.mode === "app"
      ? `grant the App "Issues: read & write", accept it on the installation for ${slug}, then re-run: ${reBindCommand}`
      : `set GITHUB_TOKEN in ${path.join(factoryRoot, ".env")} to a classic PAT with repo (or public_repo for a public repository) on ${slug} (an exported GITHUB_TOKEN wins over the file), then re-run: ${reBindCommand}`;
  const outcome = await (deps.ensureLabel ?? ensureRepoLabel)({
    ...repoRef,
    name: approval.name,
  }).catch((err: unknown) => {
    const repair = tokenWasRejected(err)
      ? credentialRepair
      : err instanceof GithubApiError && err.status === 404 && identity.mode === "app"
        ? `check the remote, and install the App on ${slug} or grant its installation access to the repo, then re-run: ${reBindCommand}`
        : err instanceof GithubApiError && err.status === 404
          ? `check the remote, and that this token can see ${slug}, then re-run: ${reBindCommand}`
          : `once that clears, re-run: ${reBindCommand}`;
    throw new JigsError(
      `${slug}'s ${approval.name} label could not be ensured: ${err instanceof Error ? err.message : String(err)}`,
      repair,
    );
  });
  deps.out(`label ${outcome}: ${repoRef.owner}/${repoRef.repo}#${approval.name}`);
}

// The likeliest operator error, given that bind used to take a checkout path.
function looksLikePath(arg: string): boolean {
  return arg.startsWith(".") || arg.startsWith("/") || arg.startsWith("~") || existsSync(arg);
}

function defaultBindingName(remoteUrl: string): string {
  const repoRef = parseGithubRemote(remoteUrl);
  const last = remoteUrl.split(/[/:]/).filter(Boolean).at(-1) ?? "";
  const repo = repoRef?.repo ?? last.replace(/\.git$/, "");
  // Lowercased: the name is typed on a command line and written into yaml.
  return repo.toLowerCase();
}

async function ensureWebhook({
  remoteUrl,
  factoryRoot,
  ingressUrl,
  reBindCommand,
  deps,
}: {
  remoteUrl: string;
  factoryRoot: string;
  ingressUrl: string | undefined;
  reBindCommand: string;
  deps: BindDeps;
}): Promise<BindResult["webhook"]> {
  if (ingressUrl === undefined) {
    deps.out("note: skipping webhook (no ingressUrl in jigs.config.ts)");
    return "skipped";
  }
  const repoRef = parseGithubRemote(remoteUrl);
  if (repoRef === null) {
    deps.out(`note: skipping webhook (${remoteUrl} is not a github.com remote)`);
    return "skipped";
  }
  const slug = `${repoRef.owner}/${repoRef.repo}`;
  const secret = githubWebhookSecret(factoryRoot);
  if (secret === undefined) {
    throw new JigsError(
      `${missingGithubWebhookSecret(factoryRoot)}, so ${slug}'s webhook cannot be signed`,
      `${githubWebhookSecretRepair(factoryRoot)}, then re-run: ${reBindCommand}`,
    );
  }
  const identity = resolveGithubIdentity(repoRef.owner, factoryRoot);
  // Creating a webhook is hook administration, which each identity holds
  // differently — and in App mode not at all until the permission is granted.
  const credentialRepair =
    identity.mode === "app"
      ? `grant the App "Repository webhooks: read & write" (Settings → Developer settings → GitHub Apps → Permissions), accept it on the installation for ${slug}, then re-run: ${reBindCommand}`
      : `set GITHUB_TOKEN in ${path.join(factoryRoot, ".env")} to a classic PAT with admin:repo_hook on ${slug} (an exported GITHUB_TOKEN wins over the file), then re-run: ${reBindCommand}`;
  if (identity.mode === "pat" && factoryEnvValue(factoryRoot, "GITHUB_TOKEN") === undefined) {
    // An ingress with no webhook is a factory whose PR gate never wakes.
    throw new JigsError(
      `jigs.config.ts declares ingressUrl but GITHUB_TOKEN is not set, so ${slug}'s webhook cannot be created`,
      credentialRepair,
    );
  }
  const repairFor = (err: unknown): string => {
    if (tokenWasRejected(err)) return credentialRepair;
    // A 404 is as often a typo in the remote as a token that cannot see a
    // private repo, and neither clears on its own.
    if (err instanceof GithubApiError && err.status === 404 && identity.mode === "app")
      return `check the remote, and install the App on ${slug} or grant its installation access to the repo, then re-run: ${reBindCommand}`;
    if (err instanceof GithubApiError && err.status === 404)
      return `check the remote, and that this token can see ${slug}, then re-run: ${reBindCommand}`;
    return `once that clears, re-run: ${reBindCommand}`;
  };
  const ensured = await ensureRepoWebhook({
    ...repoRef,
    ingressUrl,
    secret,
  }).catch((err: unknown) => {
    throw new JigsError(
      `${slug}'s webhook could not be ensured: ${err instanceof Error ? err.message : String(err)}`,
      repairFor(err),
    );
  });
  deps.out(
    ensured.outcome === "created"
      ? `webhook created: ${slug}`
      : `webhook ${ensured.outcome}: ${slug} (signing secret re-sent)`,
  );
  if (ensured.outcome === "updated") {
    deps.out(
      "note: the existing webhook's events, content type or active flag had drifted and were reset",
    );
  }
  if (ensured.otherHosts.length > 0) {
    deps.out(
      `other jigs hooks on this repo: ${ensured.otherHosts.join(", ")} — delete one by hand if it was this factory's before a hostname change`,
    );
  }
  if (identity.mode === "pat" && (readFactoryEnv(factoryRoot).GITHUB_TOKEN ?? "") === "") {
    // The webhook now posts to a service that reads the file alone, so a token
    // living in this shell only leaves the gate it wakes without one.
    deps.out(
      `note: that GITHUB_TOKEN is this shell's — the service reads ${path.join(factoryRoot, ".env")}, so set it there too`,
    );
  }
  return ensured.outcome;
}

// GitHub lays a token it will not take on 401, and one whose scopes fall short
// on 403 — but a rate limit is a 403 too, and no re-issued token clears one.
function tokenWasRejected(err: unknown): boolean {
  if (!(err instanceof GithubApiError)) return false;
  return err.status === 401 || (err.status === 403 && !/rate limit/i.test(err.body));
}
