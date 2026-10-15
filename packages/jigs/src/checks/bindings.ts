import path from "node:path";
import type { FactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import { probeRemoteAuth } from "../providers/git.ts";
import { githubAuthFor } from "../providers/github-auth.ts";
import { HubResponseError, hubConnection, hubRefused } from "../providers/hub.ts";
import { bindingFilesDir } from "../steps/workspaces/layout.ts";
import { CopySourceMissingError, copySourceMatches } from "../steps/workspaces/provision.ts";
import {
  type BindingEntry,
  FACTORY_CONFIG_FILE,
  type FactoryConfig,
} from "../workflow/factory-schema.ts";
import { bindingRepository } from "../workflow/github-remote.ts";
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

  if (hubConnection(ctx) === undefined) return { ok: true };
  return checkInstallationReach(ctx, name, binding);
}

// Every clone, fetch, push, pull request and wake goes through the binding's
// GitHub installation, which may not include the repository.
async function checkInstallationReach(
  ctx: FactoryContext,
  name: string,
  { remote, installationName }: BindingEntry,
): Promise<CheckResult> {
  const { owner, repo } = bindingRepository(remote);
  const slug = `${owner}/${repo}`;
  try {
    const token = await githubAuthFor(installationName, ctx).bearer();
    const stderr = await probeRemoteAuth(`https://github.com/${slug}.git`, token, PROBE_TIMEOUT_MS);
    if (stderr === null) return { ok: true };
    return {
      ok: false,
      reason: `git could not reach ${slug} through GitHub installation ${installationName}: ${stderr}`,
      repair: `in GitHub, give installation ${installationName} read access to ${slug}'s contents, or set bindings.${name}.installationName in ${FACTORY_CONFIG_FILE} to an installation that has it, then: \`pnpm exec jigs up\``,
    };
  } catch (err) {
    if (err instanceof HubResponseError)
      return hubRefused(`the hub gave no token for GitHub installation ${installationName}`, err);
    return {
      ok: false,
      reason: `could not reach ${slug} through GitHub installation ${installationName}: ${err instanceof Error ? err.message : String(err)}`,
      repair: "retry: `pnpm exec jigs doctor`, and check GitHub's status page if it repeats",
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
