import { existsSync } from "node:fs";
import {
  parseFactoryConfig,
  readFactoryConfigText,
} from "../config/factory-config.ts";
import { locateFactoryRoot } from "../config/locate-factory.ts";
import { CliError } from "../errors.ts";
import { checkoutRoot, deriveDefaultBranch, resolveRemoteUrl } from "../git.ts";
import { expandHome } from "../paths.ts";

export interface BindingsDeps {
  cwd: string;
  home?: string;
}

export interface BindingRow {
  name: string;
  path: string;
  remote: string;
  state: string;
}

export async function listBindings(deps: BindingsDeps): Promise<BindingRow[]> {
  const factoryRoot = locateFactoryRoot(deps.cwd);
  const config = parseFactoryConfig(readFactoryConfigText(factoryRoot));
  const rows: BindingRow[] = [];
  for (const [name, binding] of Object.entries(config.bindings)) {
    rows.push({
      name,
      path: binding.path,
      remote: binding.remote,
      state: await resolveState(binding.path, binding.remote, deps.home),
    });
  }
  return rows;
}

async function resolveState(
  bindingPath: string,
  pinnedRemote: string,
  home?: string,
): Promise<string> {
  const target = expandHome(bindingPath, home);
  if (!existsSync(target)) return "path missing";
  if ((await checkoutRoot(target)) === null) return "not a git checkout";
  try {
    const { remote, url } = await resolveRemoteUrl(target);
    if (url !== pinnedRemote) return `remote mismatch: found ${url}`;
    const branch = await deriveDefaultBranch(target, remote);
    return branch !== null
      ? `ok (default: ${branch})`
      : `ok (default: unknown — run: git remote set-head ${remote} -a)`;
  } catch (err) {
    if (err instanceof CliError) return err.message;
    throw err;
  }
}
