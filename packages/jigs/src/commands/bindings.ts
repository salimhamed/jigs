import {
  parseFactoryConfig,
  readFactoryConfigText,
} from "../config/factory-config.ts";
import { locateFactoryRoot } from "../config/factory-root.ts";
import { CliError } from "../errors.ts";
import { deriveDefaultBranch, resolveRemoteUrl } from "../git.ts";
import { hasBindingClone } from "../worktrees/clone.ts";
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
  // The same marker the startup gate, doctor and the worktree request read,
  // so all four agree about which bindings have a clone.
  if (!hasBindingClone(repoDir)) return "not cloned (restart the service)";
  try {
    const { remote, url } = await resolveRemoteUrl(repoDir);
    if (url !== pinnedRemote) return `cloned, remote drifted: ${url}`;
    const branch = await deriveDefaultBranch(repoDir, remote);
    if (branch === null) {
      // Past the marker, which is origin/HEAD itself — so this is a ref git
      // wrote and no longer reads as a branch.
      throw new CliError(`${repoDir} has an origin/HEAD naming no branch`);
    }
    return `cloned (default: ${branch})`;
  } catch (err) {
    if (err instanceof CliError) return err.message;
    throw err;
  }
}
