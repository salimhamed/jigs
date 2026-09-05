import { existsSync } from "node:fs";
import path from "node:path";
import {
  parseFactoryConfig,
  readFactoryConfigText,
} from "../config/factory-config.ts";
import { locateFactoryRoot } from "../config/locate-factory.ts";
import { CliError } from "../errors.ts";
import { deriveDefaultBranch, resolveRemoteUrl } from "../git.ts";
import { bindingRepoDir } from "../worktrees/layout.ts";

export interface BindingsDeps {
  cwd: string;
}

export interface BindingRow {
  name: string;
  remote: string;
  clone: string;
  state: string;
}

// Offline by decree: what a binding is, where its clone would be, and what the
// clone on disk says — never the network.
export async function listBindings(deps: BindingsDeps): Promise<BindingRow[]> {
  const factoryRoot = locateFactoryRoot(deps.cwd);
  const config = parseFactoryConfig(readFactoryConfigText(factoryRoot));
  const rows: BindingRow[] = [];
  for (const [name, binding] of Object.entries(config.bindings)) {
    const clone = bindingRepoDir({ factoryRoot, bindingName: name });
    rows.push({
      name,
      remote: binding.remote,
      clone,
      state: await resolveState(clone, binding.remote),
    });
  }
  return rows;
}

async function resolveState(
  repoDir: string,
  pinnedRemote: string,
): Promise<string> {
  if (!existsSync(path.join(repoDir, "HEAD"))) {
    return "not cloned (cloned on the first worktree)";
  }
  try {
    const { remote, url } = await resolveRemoteUrl(repoDir);
    if (url !== pinnedRemote) return `cloned, remote drifted: ${url}`;
    const branch = await deriveDefaultBranch(repoDir, remote);
    return branch !== null
      ? `cloned (default: ${branch})`
      : "cloned (default: unknown — will be set on the next fetch)";
  } catch (err) {
    if (err instanceof CliError) return err.message;
    throw err;
  }
}
