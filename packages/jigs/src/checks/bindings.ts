import path from "node:path";
import {
  type BindingEntry,
  FACTORY_CONFIG_FILE,
  parseFactoryConfig,
  readFactoryConfigText,
} from "../config/factory-config.ts";
import { probeRemoteAuth } from "../git.ts";
import {
  type Check,
  type CheckResult,
  failedCheck,
  PROBE_TIMEOUT_MS,
} from "./catalog.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "./core.ts";

export interface BindingChecksOptions {
  // A thunk, not a path: locating the factory repo is itself fallible, and
  // one unreadable jigs.yml must collapse to one failed check rather than a
  // throw out of the trigger path.
  factoryRoot: () => string;
  // Omitted means every declared binding — what doctor needs, having no
  // pipeline manifest to name them.
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
      ? `start the service from a factory repo — the directory holding ${FACTORY_CONFIG_FILE}`
      : `create or repair ${path.join(factoryRoot, FACTORY_CONFIG_FILE)}, then: ${RESTART_SERVICE}`,
  );
}

export function bindingChecks(options: BindingChecksOptions): Check[] {
  // A pipeline requiring no bindings must not need a factory config at all.
  if (options.names?.length === 0) return [];
  let bindings: Record<string, BindingEntry>;
  let factoryRoot: string | undefined;
  try {
    factoryRoot = options.factoryRoot();
    bindings = parseFactoryConfig(readFactoryConfigText(factoryRoot)).bindings;
  } catch (err) {
    return [factoryConfigFailure(err, factoryRoot)];
  }
  return (options.names ?? Object.keys(bindings)).map((name) => ({
    id: `binding.${name}`,
    label: `binding ${name}`,
    run: () => checkBinding(name, bindings[name]),
  }));
}

async function checkBinding(
  name: string,
  binding: BindingEntry | undefined,
): Promise<CheckResult> {
  if (binding === undefined) {
    return {
      ok: false,
      reason: `no binding named '${name}' in ${FACTORY_CONFIG_FILE}`,
      // The remote is genuinely not knowable from the manifest; the name is,
      // so the invocation is as exact as it can be.
      repair: `run: jigs bind <the-${name}-remote-url> --name ${name}`,
    };
  }

  // The one thing worth checking before a run exists: the clone is lazy, so
  // without this a dead ssh agent surfaces mid-run at the first worktree.
  const stderr = await probeRemoteAuth(binding.remote, PROBE_TIMEOUT_MS);
  if (stderr !== null) {
    return {
      ok: false,
      reason: `git could not reach ${binding.remote}: ${stderr}`,
      repair: `give the service credentials for ${binding.remote} (an ssh key it can read, or GITHUB_TOKEN in ${SERVICE_ENV_FILE}), then: ${RESTART_SERVICE}`,
    };
  }
  return { ok: true };
}
