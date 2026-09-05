import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  parseFactoryConfig,
  readFactoryConfigText,
  upsertBinding,
  writeFactoryConfigText,
} from "../config/factory-config.ts";
import { locateFactoryRoot } from "../config/locate-factory.ts";
import { CliError } from "../errors.ts";
import { assertCheckoutRoot, resolveRemoteUrl } from "../git.ts";
import {
  ensureRepoWebhook,
  ensureWebhookSecret,
  parseGithubRemote,
} from "../github-webhook.ts";
import { contractHome, expandHome } from "../paths.ts";

const BINDING_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface BindDeps {
  cwd: string;
  home?: string;
  out: (line: string) => void;
}

export interface BindOptions {
  name?: string;
}

export interface BindResult {
  name: string;
  path: string;
  remote: string;
  webhook: "created" | "verified" | "updated" | "skipped";
}

export async function bindRepo(
  targetPath: string,
  deps: BindDeps,
  options: BindOptions = {},
): Promise<BindResult> {
  const factoryRoot = locateFactoryRoot(deps.cwd);
  const target = path.resolve(deps.cwd, expandHome(targetPath, deps.home));
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new CliError(`${targetPath} is not a directory`);
  }
  await assertCheckoutRoot(target);
  const { url } = await resolveRemoteUrl(target);

  const name = options.name ?? path.basename(target);
  if (!BINDING_NAME_PATTERN.test(name)) {
    throw new CliError(
      `invalid binding name ${JSON.stringify(name)}`,
      "names must match [A-Za-z0-9][A-Za-z0-9._-]* — pass --name to choose one",
    );
  }

  const text = readFactoryConfigText(factoryRoot);
  const config = parseFactoryConfig(text);
  const resolveBindingPath = (p: string) =>
    path.resolve(expandHome(p, deps.home));

  const existing = config.bindings[name];
  if (existing !== undefined && resolveBindingPath(existing.path) !== target) {
    throw new CliError(
      `${name} is already bound to ${existing.path}`,
      `bind under a different name: jigs bind ${targetPath} --name <n>`,
    );
  }
  const duplicate = Object.entries(config.bindings).find(
    ([boundName, binding]) =>
      boundName !== name && resolveBindingPath(binding.path) === target,
  );
  if (duplicate !== undefined) {
    deps.out(`note: ${target} is already bound as ${duplicate[0]}`);
  }
  if (existing !== undefined && existing.remote !== url) {
    deps.out(`remote pin updated: ${existing.remote} → ${url}`);
  }

  const storedPath = contractHome(target, deps.home);
  const updated = upsertBinding(text, name, { path: storedPath, remote: url });
  if (updated !== text) {
    writeFactoryConfigText(factoryRoot, updated);
  }
  deps.out(
    existing !== undefined
      ? `updated binding ${name} → ${storedPath}`
      : `bound ${name} → ${storedPath}`,
  );

  const webhook = await ensureWebhook(url, config.ingress_url, deps);
  return { name, path: storedPath, remote: url, webhook };
}

async function ensureWebhook(
  remoteUrl: string,
  ingressUrl: string | undefined,
  deps: BindDeps,
): Promise<BindResult["webhook"]> {
  if (ingressUrl === undefined) {
    deps.out("note: skipping webhook (no ingress_url in jigs.yml)");
    return "skipped";
  }
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token === "") {
    deps.out("note: skipping webhook (GITHUB_TOKEN is not set)");
    return "skipped";
  }
  const repoRef = parseGithubRemote(remoteUrl);
  if (repoRef === null) {
    deps.out(
      `note: skipping webhook (${remoteUrl} is not a github.com remote)`,
    );
    return "skipped";
  }
  const secret = ensureWebhookSecret();
  const outcome = await ensureRepoWebhook({ ...repoRef, ingressUrl, secret });
  deps.out(`webhook ${outcome}: ${repoRef.owner}/${repoRef.repo}`);
  return outcome;
}
