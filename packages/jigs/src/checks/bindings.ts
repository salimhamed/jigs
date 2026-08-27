import { existsSync } from "node:fs";
import {
  type Binding,
  FACTORY_CONFIG_FILE,
  parseFactoryConfig,
  readFactoryConfigText,
} from "../config/factory-config.ts";
import { checkoutRoot, probeRemoteAuth, resolveRemoteUrl } from "../git.ts";
import { expandHome } from "../paths.ts";
import {
  CHECK_TIMEOUT_MS,
  type Check,
  type CheckResult,
  failedCheck,
} from "./catalog.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "./core.ts";

export interface BindingChecksOptions {
  // A thunk, not a path: locating the factory repo is itself fallible, and
  // one unreadable jigs.yml must collapse to one failed check rather than a
  // throw out of the trigger path.
  factoryRoot: () => string;
  names: string[];
}

export function readBindings(
  factoryRoot: () => string,
): Record<string, Binding> {
  return parseFactoryConfig(readFactoryConfigText(factoryRoot())).bindings;
}

export function factoryConfigFailure(err: unknown): Check {
  return failedCheck(
    "binding.factory-config",
    FACTORY_CONFIG_FILE,
    `the factory config could not be read: ${err instanceof Error ? err.message : String(err)}`,
    `point the service at the factory repo with JIGS_FACTORY_ROOT in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`,
  );
}

export function bindingChecks(options: BindingChecksOptions): Check[] {
  // A pipeline requiring no bindings must not need a factory config at all.
  if (options.names.length === 0) return [];
  let bindings: Record<string, Binding>;
  try {
    bindings = readBindings(options.factoryRoot);
  } catch (err) {
    return [factoryConfigFailure(err)];
  }
  return options.names.map((name) => ({
    id: `binding.${name}`,
    label: `binding ${name}`,
    run: () => checkBinding(name, bindings[name]),
  }));
}

async function checkBinding(
  name: string,
  binding: Binding | undefined,
): Promise<CheckResult> {
  if (binding === undefined) {
    return {
      ok: false,
      reason: `no binding named '${name}' in ${FACTORY_CONFIG_FILE}`,
      // The checkout path is genuinely not knowable from the manifest; the
      // name is, so the invocation is as exact as it can be.
      repair: `run: jigs bind <path-to-the-${name}-checkout> --name ${name}`,
    };
  }

  const dir = expandHome(binding.path);
  if (!existsSync(dir)) {
    return {
      ok: false,
      reason: `${dir} does not exist`,
      repair: `clone ${binding.remote} to ${dir}, or re-bind: jigs bind <path> --name ${name}`,
    };
  }

  if ((await checkoutRoot(dir)) === null) {
    return {
      ok: false,
      reason: `${dir} is not a git checkout`,
      repair: `clone ${binding.remote} to ${dir}, or re-bind: jigs bind <path> --name ${name}`,
    };
  }

  let url: string;
  try {
    url = (await resolveRemoteUrl(dir)).url;
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      repair: `give ${dir} its remote back: git -C ${dir} remote add origin ${binding.remote}`,
    };
  }
  if (url !== binding.remote) {
    return {
      ok: false,
      reason: `${dir} points at ${url}, but the binding is pinned to ${binding.remote}`,
      repair: `re-point the checkout (git -C ${dir} remote set-url origin ${binding.remote}) or re-pin the binding: jigs bind ${dir} --name ${name}`,
    };
  }

  const stderr = await probeRemoteAuth(binding.remote, CHECK_TIMEOUT_MS);
  if (stderr !== null) {
    return {
      ok: false,
      reason: `git could not reach ${binding.remote}: ${stderr}`,
      repair: `give the service credentials for ${binding.remote} (an ssh key it can read, or GITHUB_TOKEN in ${SERVICE_ENV_FILE}), then: ${RESTART_SERVICE}`,
    };
  }
  return { ok: true };
}
