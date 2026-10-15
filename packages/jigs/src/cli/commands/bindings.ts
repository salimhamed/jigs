import { currentFactoryContext } from "../../config/factory-context.ts";
import { deriveDefaultBranch } from "../../providers/git.ts";
import { hasBindingClone } from "../../steps/workspaces/clone.ts";
import { cloneRepoDir } from "../../steps/workspaces/layout.ts";
import { displayPath, formatTable } from "../output.ts";

export interface BindingsDeps {
  out: (line: string) => void;
}

// Offline by decree: what a binding is, where its clone would be, and what the
// clone on disk says — never the network.
export async function listBindings(deps: BindingsDeps): Promise<void> {
  const { root: factoryRoot, config } = currentFactoryContext();
  const rows: string[][] = [];
  for (const [name, binding] of Object.entries(config.bindings)) {
    const clone = cloneRepoDir({ factoryRoot, bindingName: name });
    rows.push([
      name,
      binding.remote,
      binding.installationName,
      displayPath(clone),
      await resolveState(clone),
    ]);
  }
  if (rows.length === 0) {
    deps.out("no bindings");
    return;
  }
  for (const line of formatTable(["NAME", "REMOTE", "INSTALLATION", "CLONE", "STATE"], rows)) {
    deps.out(line);
  }
}

// The same marker the worktree request reads before it clones.
async function resolveState(repoDir: string): Promise<string> {
  if (!hasBindingClone(repoDir)) return "not cloned yet";
  return `cloned (default: ${await deriveDefaultBranch(repoDir)})`;
}
