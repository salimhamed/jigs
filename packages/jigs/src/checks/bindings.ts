import path from "node:path";
import type { FactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import { RESTART_SERVICE } from "../providers/credentials.ts";
import { probeRemoteAuth } from "../providers/git.ts";
import { githubGet } from "../providers/github-api.ts";
import { GitHubApiError } from "../providers/github-http.ts";
import { parseGithubRemote } from "../providers/github-remote.ts";
import { HubResponseError, hubConnection, hubRefused } from "../providers/hub.ts";
import { hasBindingClone } from "../steps/workspaces/clone.ts";
import { bindingFilesDir, cloneRepoDir } from "../steps/workspaces/layout.ts";
import { CopySourceMissingError, copySourceMatches } from "../steps/workspaces/provision.ts";
import {
  type BindingEntry,
  FACTORY_CONFIG_FILE,
  type FactoryConfig,
} from "../workflow/factory-schema.ts";
import { PROBE_TIMEOUT_MS } from "./catalog.ts";
import { type Check, type CheckResult, failedCheck } from "./check.ts";

export interface BindingChecksOptions {
  // Reading its config is fallible, and one unreadable jigs.config.ts must
  // collapse to one failed check rather than a throw out of the whole report.
  context: FactoryContext;
  // Omitted means every declared binding — what doctor needs, having no
  // workflow manifest to name them.
  names?: string[];
}

// The service runs inside the factory repo now, so the repair is about that
// one file — naming it by path, unless there was no factory root to name.
function factoryConfigFailure(err: unknown, factoryRoot?: string): Check {
  return failedCheck(
    "binding.factory-config",
    FACTORY_CONFIG_FILE,
    `the factory config could not be read: ${err instanceof Error ? err.message : String(err)}`,
    factoryRoot === undefined
      ? `start the service from a factory repo, the directory holding ${FACTORY_CONFIG_FILE}`
      : `create or repair ${path.join(factoryRoot, FACTORY_CONFIG_FILE)}, then: \`pnpm exec jigs up\``,
  );
}

export function bindingChecks(options: BindingChecksOptions): Check[] {
  // A workflow requiring no bindings must not need a factory config at all.
  if (options.names?.length === 0) return [];
  let root: string | undefined;
  let config: FactoryConfig;
  try {
    root = options.context.root;
    config = options.context.config;
  } catch (err) {
    return [factoryConfigFailure(err, root)];
  }
  const factoryRoot = root;
  return (options.names ?? Object.keys(config.bindings)).map((name) => ({
    id: `binding.${name}`,
    label: `binding ${name}`,
    run: () => checkBinding(options.context, factoryRoot, name, config.bindings[name]),
  }));
}

async function checkBinding(
  ctx: FactoryContext,
  factoryRoot: string,
  name: string,
  binding: BindingEntry | undefined,
): Promise<CheckResult> {
  if (binding === undefined) {
    return {
      ok: false,
      reason: `no binding named '${name}' in ${FACTORY_CONFIG_FILE}`,
      // The remote is genuinely not knowable from the manifest; the name is,
      // so the invocation is as exact as it can be.
      repair: `bind it: \`pnpm exec jigs bind <the-${name}-remote-url> --binding-name ${name}\``,
    };
  }

  const copyFailure = checkCopySources(factoryRoot, name, binding.copy);
  if (copyFailure !== null) return copyFailure;

  // A binding declared while the service was running has no clone, and the
  // worktree request would be the first thing to say so — mid-run.
  if (!hasBindingClone(cloneRepoDir({ factoryRoot, bindingName: name }))) {
    return {
      ok: false,
      reason: `binding ${name} has no clone yet`,
      repair: `the service clones every binding when it starts, so restart it: \`${RESTART_SERVICE}\``,
    };
  }

  // Cheap next to the clone, and the one thing that reports a dead ssh agent
  // before a run burns an agent on it.
  const stderr = await probeRemoteAuth(binding.remote, PROBE_TIMEOUT_MS);
  if (stderr !== null) {
    return {
      ok: false,
      reason: `git could not reach ${binding.remote}: ${stderr}`,
      repair: `give the service credentials for ${binding.remote} (an ssh key it can read, or a git credential helper for an https remote), then: \`${RESTART_SERVICE}\``,
    };
  }
  if (hubConnection(ctx) === undefined) return { ok: true };
  return checkInstallationReach(ctx, name, binding);
}

// Pushes go over git, but pull requests, labels and wakes go through the
// binding's GitHub installation, which may not include the repository.
async function checkInstallationReach(
  ctx: FactoryContext,
  name: string,
  { remote, installationName }: BindingEntry,
): Promise<CheckResult> {
  const repository = parseGithubRemote(remote);
  if (repository === null) return { ok: true };
  const slug = `${repository.owner}/${repository.repo}`;
  try {
    await githubGet(installationName, `/repos/${slug}`, ctx);
    return { ok: true };
  } catch (err) {
    if (err instanceof HubResponseError)
      return hubRefused(`the hub gave no token for GitHub installation ${installationName}`, err);
    const missing = err instanceof GitHubApiError && err.status === 404;
    return {
      ok: false,
      reason: missing
        ? `GitHub installation ${installationName} cannot reach ${slug}`
        : `could not read ${slug} through GitHub installation ${installationName}: ${err instanceof Error ? err.message : String(err)}`,
      repair: missing
        ? `in GitHub, give installation ${installationName} access to ${slug}, or set bindings.${name}.installationName in ${FACTORY_CONFIG_FILE} to an installation that has it, then: \`pnpm exec jigs up\``
        : "retry: `pnpm exec jigs doctor`, and check GitHub's status page if it repeats",
    };
  }
}

// Provisioning would refuse the same entries, but only after the run started.
function checkCopySources(factoryRoot: string, name: string, copy: string[]): CheckResult | null {
  try {
    copySourceMatches(factoryRoot, name, copy);
    return null;
  } catch (err) {
    if (err instanceof CopySourceMissingError)
      return {
        ok: false,
        reason: err.message,
        repair: `add a file matching ${err.entry} under ${bindingFilesDir(factoryRoot, name)}/, or remove the entry from ${FACTORY_CONFIG_FILE}`,
      };
    if (err instanceof JigsError)
      return { ok: false, reason: err.message, repair: err.hint ?? "fix the binding's copy list" };
    throw err;
  }
}
