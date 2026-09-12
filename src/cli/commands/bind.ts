import { existsSync } from "node:fs";
import path from "node:path";
import { upsertBinding } from "../../config/binding-edit.ts";
import {
  readFactoryConfig,
  readFactoryConfigText,
  writeFactoryConfigText,
} from "../../config/factory-config.ts";
import { factoryEnvValue, readFactoryEnv } from "../../config/factory-env.ts";
import { locateFactoryRoot } from "../../config/factory-root.ts";
import { JigsError } from "../../errors.ts";
import {
  ensureRepoWebhook,
  ensureWebhookSecret,
  GithubApiError,
  parseGithubRemote,
} from "../../providers/github-webhook.ts";
import { hasBindingClone } from "../../steps/worktree/clone.ts";
import { bindingDir, bindingRepoDir } from "../../steps/worktree/layout.ts";

const BINDING_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface BindDeps {
  cwd: string;
  out: (line: string) => void;
}

export interface BindOptions {
  name?: string;
}

export interface BindResult {
  name: string;
  remote: string;
  webhook: "created" | "verified" | "updated" | "skipped";
}

// A pure config edit plus the webhook leg: nothing here touches the network for
// the repo itself, and the clone is the service's to make at its next start.
export async function bindRepo(
  remoteUrl: string,
  deps: BindDeps,
  options: BindOptions = {},
): Promise<BindResult> {
  const factoryRoot = locateFactoryRoot(deps.cwd);
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

  const name = options.name ?? defaultBindingName(remoteUrl);
  if (!BINDING_NAME_PATTERN.test(name)) {
    throw new JigsError(
      `invalid binding name ${JSON.stringify(name)}`,
      "names must match [A-Za-z0-9][A-Za-z0-9._-]* — pass --name to choose one",
    );
  }

  const text = readFactoryConfigText(factoryRoot);
  const updated = upsertBinding(text, name, remoteUrl);
  const config = readFactoryConfig(factoryRoot);
  const existing = config.bindings[name];
  if (existing !== undefined && existing.remote !== remoteUrl) {
    // Repointing silently would fetch an unrelated history into an object
    // store that already holds another repo's.
    throw new JigsError(
      `${name} is already bound to ${existing.remote}`,
      `jigs unbind ${name}, then bind again — the clone at ${bindingDir({ factoryRoot, bindingName: name })} holds the old repo's objects`,
    );
  }

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
    deps.out(`restart the service to clone ${name}: jigs service restart`);
  }

  // Last, so a webhook that cannot be ensured leaves the binding recorded and
  // the whole verb re-runnable: the config edit above is idempotent and so is
  // the registration below.
  const webhook = await ensureWebhook({
    remoteUrl,
    factoryRoot,
    ingressUrl: config.ingressUrl,
    // The repair it prints has to land on this binding, not on the one the
    // remote alone would derive.
    reBindCommand:
      options.name === undefined
        ? `jigs bind ${remoteUrl}`
        : `jigs bind ${remoteUrl} --name ${name}`,
    deps,
  });
  return { name, remote: remoteUrl, webhook };
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
  const envFile = path.join(factoryRoot, ".env");
  const tokenRepair = `set GITHUB_TOKEN in ${envFile} to a classic PAT with admin:repo_hook on ${slug} (an exported GITHUB_TOKEN wins over the file), then re-run: ${reBindCommand}`;
  const declaredToken = readFactoryEnv(factoryRoot).GITHUB_TOKEN ?? "";
  const token = factoryEnvValue(factoryRoot, "GITHUB_TOKEN");
  if (token === undefined) {
    // An ingress with no webhook is a factory whose PR gate never wakes.
    throw new JigsError(
      `jigs.config.ts declares ingressUrl but GITHUB_TOKEN is not set, so ${slug}'s webhook cannot be created`,
      tokenRepair,
    );
  }
  const repairFor = (err: unknown): string => {
    if (tokenWasRejected(err)) return tokenRepair;
    // A 404 is as often a typo in the remote as a token that cannot see a
    // private repo, and neither clears on its own.
    if (err instanceof GithubApiError && err.status === 404)
      return `check the remote, and that this token can see ${slug}, then re-run: ${reBindCommand}`;
    return `once that clears, re-run: ${reBindCommand}`;
  };
  const secret = ensureWebhookSecret();
  const ensured = await ensureRepoWebhook({
    ...repoRef,
    ingressUrl,
    secret,
    token,
  }).catch((err: unknown) => {
    throw new JigsError(
      `${slug}'s webhook could not be ensured: ${err instanceof Error ? err.message : String(err)}`,
      repairFor(err),
    );
  });
  deps.out(`webhook ${ensured.outcome}: ${slug}`);
  if (ensured.otherHosts.length > 0) {
    deps.out(
      `other jigs hooks on this repo: ${ensured.otherHosts.join(", ")} — delete one by hand if it was this factory's before a hostname change`,
    );
  }
  if (declaredToken === "") {
    // The webhook now posts to a service that reads the file alone, so a token
    // living in this shell only leaves the gate it wakes without one.
    deps.out(
      `note: that GITHUB_TOKEN is this shell's — the service reads ${envFile}, so set it there too`,
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
