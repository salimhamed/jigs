import path from "node:path";
import {
  type BindingEntry,
  FACTORY_CONFIG_FILE,
  installationFor,
  readFactoryConfig,
} from "../config/factory-config.ts";
import { JigsError } from "../errors.ts";
import { probeRemoteAuth } from "../providers/git.ts";
import { parseGithubRemote } from "../providers/github-webhook.ts";
import { hasBindingClone } from "../steps/workspaces/clone.ts";
import { bindingFilesDir, cloneRepoDir } from "../steps/workspaces/layout.ts";
import { CopySourceMissingError, copySourceMatches } from "../steps/workspaces/provision.ts";
import { type Check, type CheckResult, failedCheck, PROBE_TIMEOUT_MS } from "./catalog.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "./core.ts";

export interface BindingChecksOptions {
  // A thunk, not a path: locating the factory repo is itself fallible, and
  // one unreadable jigs.config.ts must collapse to one failed check rather than a
  // throw out of the trigger path.
  factoryRoot: () => string;
  // Omitted means every declared binding — what doctor needs, having no
  // workflow manifest to name them.
  names?: string[];
}

// The service runs inside the factory repo now, so the repair is about that
// one file — naming it by path, since the thunk may have failed before there
// was a factory root to name.
function factoryConfigFailure(err: unknown, factoryRoot?: string): Check {
  return failedCheck(
    "binding.factory-config",
    FACTORY_CONFIG_FILE,
    `the factory config could not be read: ${err instanceof Error ? err.message : String(err)}`,
    factoryRoot === undefined
      ? `start the service from a factory repo, the directory holding ${FACTORY_CONFIG_FILE}`
      : `create or repair ${path.join(factoryRoot, FACTORY_CONFIG_FILE)}, then: \`${RESTART_SERVICE}\``,
  );
}

export function bindingChecks(options: BindingChecksOptions): Check[] {
  // A workflow requiring no bindings must not need a factory config at all.
  if (options.names?.length === 0) return [];
  let bindings: Record<string, BindingEntry>;
  let factoryRoot: string | undefined;
  try {
    factoryRoot = options.factoryRoot();
    bindings = readFactoryConfig(factoryRoot).bindings;
  } catch (err) {
    return [factoryConfigFailure(err, factoryRoot)];
  }
  const root = factoryRoot;
  return (options.names ?? Object.keys(bindings)).map((name) => ({
    id: `binding.${name}`,
    label: `binding ${name}`,
    run: () => checkBinding(root, name, bindings[name]),
  }));
}

async function checkBinding(
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

  const account = parseGithubRemote(binding.remote)?.owner;
  if (account) {
    try {
      installationFor(readFactoryConfig(factoryRoot).github.identities, account);
    } catch (err) {
      if (err instanceof JigsError)
        return {
          ok: false,
          reason: err.message,
          repair: err.hint ?? "repair github installations",
        };
      throw err;
    }
  }

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
      repair: `give the service credentials for ${binding.remote} (an ssh key it can read, or GITHUB_TOKEN in ${SERVICE_ENV_FILE}), then: \`${RESTART_SERVICE}\``,
    };
  }
  return { ok: true };
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
        repair: `add ${path.join(bindingFilesDir(factoryRoot, name), err.entry)}, or remove ${err.entry} from the binding's copy list in ${FACTORY_CONFIG_FILE}`,
      };
    if (err instanceof JigsError)
      return { ok: false, reason: err.message, repair: err.hint ?? "fix the binding's copy list" };
    throw err;
  }
}
