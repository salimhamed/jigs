import {
  parseFactoryConfig,
  readFactoryConfigText,
} from "../config/factory-config.ts";
import { locateFactoryRoot } from "../config/factory-root.ts";
import { JigsError } from "../errors.ts";
import { deriveDefaultBranch, resolveRemoteUrl } from "../git.ts";
import { formatTable } from "../table.ts";
import { hasBindingClone } from "../worktrees/clone.ts";
import { bindingRepoDir } from "../worktrees/layout.ts";

export interface BindingsDeps {
  cwd: string;
  out: (line: string) => void;
}

// Offline by decree: what a binding is, where its clone would be, and what the
// clone on disk says — never the network.
export async function listBindings(deps: BindingsDeps): Promise<void> {
  const factoryRoot = locateFactoryRoot(deps.cwd);
  const config = parseFactoryConfig(readFactoryConfigText(factoryRoot));
  const rows: string[][] = [];
  for (const [name, binding] of Object.entries(config.bindings)) {
    const clone = bindingRepoDir({ factoryRoot, bindingName: name });
    rows.push([
      name,
      binding.remote,
      clone,
      await resolveState(clone, binding.remote),
    ]);
  }
  if (rows.length === 0) {
    deps.out("no bindings");
    return;
  }
  for (const line of formatTable(["NAME", "REMOTE", "CLONE", "STATE"], rows)) {
    deps.out(line);
  }
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
      throw new JigsError(`${repoDir} has an origin/HEAD naming no branch`);
    }
    return `cloned (default: ${branch})`;
  } catch (err) {
    if (err instanceof JigsError) return err.message;
    throw err;
  }
}
