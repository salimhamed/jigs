import { existsSync } from "node:fs";
import path from "node:path";
import {
  parseFactoryConfig,
  readFactoryConfigText,
  upsertBinding,
  writeFactoryConfigText,
} from "../config/factory-config.ts";
import { factoryEnvValue } from "../config/factory-env.ts";
import { locateFactoryRoot } from "../config/factory-root.ts";
import { JigsError } from "../errors.ts";
import {
  ensureRepoWebhook,
  ensureWebhookSecret,
  parseGithubRemote,
} from "../github-webhook.ts";
import { bindingDir } from "../worktrees/layout.ts";

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
  const config = parseFactoryConfig(text);
  const existing = config.bindings[name];
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
  if (existing !== undefined) {
    deps.out(`${name} already points at ${remoteUrl}`);
  } else {
    deps.out(`bound ${name} → ${remoteUrl}`);
    // The running service knows nothing of this binding, and every run that
    // names it is refused until one that does has cloned it.
    deps.out(`restart the service to clone ${name}: jigs service restart`);
  }

  // Last, so a webhook that cannot be ensured leaves the binding recorded and
  // the whole verb re-runnable: the config edit above is idempotent and so is
  // the registration below.
  const webhook = await ensureWebhook({
    remoteUrl,
    factoryRoot,
    ingressUrl: config.ingress_url,
    deps,
  });
  return { name, remote: remoteUrl, webhook };
}

// The likeliest operator error, given that bind used to take a checkout path.
function looksLikePath(arg: string): boolean {
  return (
    arg.startsWith(".") ||
    arg.startsWith("/") ||
    arg.startsWith("~") ||
    existsSync(arg)
  );
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
  deps,
}: {
  remoteUrl: string;
  factoryRoot: string;
  ingressUrl: string | undefined;
  deps: BindDeps;
}): Promise<BindResult["webhook"]> {
  if (ingressUrl === undefined) {
    deps.out("note: skipping webhook (no ingress_url in jigs.yml)");
    return "skipped";
  }
  const repoRef = parseGithubRemote(remoteUrl);
  if (repoRef === null) {
    deps.out(
      `note: skipping webhook (${remoteUrl} is not a github.com remote)`,
    );
    return "skipped";
  }
  const slug = `${repoRef.owner}/${repoRef.repo}`;
  const repair = `set GITHUB_TOKEN in ${path.join(factoryRoot, ".env")} to a classic PAT with admin:repo_hook on ${slug} (an exported GITHUB_TOKEN wins over the file), then re-run: jigs bind ${remoteUrl}`;
  const token = factoryEnvValue(factoryRoot, "GITHUB_TOKEN");
  if (token === undefined) {
    // An ingress with no webhook is a factory whose PR gate never wakes, and
    // the note this replaced read as a pass on the very first real bind.
    throw new JigsError(
      `jigs.yml declares ingress_url but GITHUB_TOKEN is not set, so ${slug}'s webhook cannot be created`,
      repair,
    );
  }
  const secret = ensureWebhookSecret();
  const outcome = await ensureRepoWebhook({
    ...repoRef,
    ingressUrl,
    secret,
    token,
  }).catch((err: unknown) => {
    throw new JigsError(
      `${slug}'s webhook could not be ensured: ${err instanceof Error ? err.message : String(err)}`,
      repair,
    );
  });
  deps.out(`webhook ${outcome}: ${slug}`);
  return outcome;
}
