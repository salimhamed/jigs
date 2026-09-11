import { createHash } from "node:crypto";
import path from "node:path";
import { jigsDataDir } from "../../config/paths.ts";

// Binding names are unique only per factory repo, so the path needs factory
// identity — dirname alone would collide two factories named the same, and it
// is what keeps two factories' clones of one remote apart.
export function factorySlug(factoryRoot: string): string {
  const resolved = path.resolve(factoryRoot);
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${path.basename(resolved)}-${hash}`;
}

export function branchDirname(branch: string): string {
  return branch.replaceAll("/", "-");
}

export interface BindingDirOptions {
  factoryRoot: string;
  bindingName: string;
}

export interface WorktreePathOptions extends BindingDirOptions {
  branch: string;
}

// Everything a binding owns is co-located, so "where does this binding live"
// has one answer that `du -sh` prices and `rm -rf` resets.
export function bindingDir(options: BindingDirOptions): string {
  return path.join(
    jigsDataDir(),
    "bindings",
    factorySlug(options.factoryRoot),
    options.bindingName,
  );
}

export function bindingRepoDir(options: BindingDirOptions): string {
  return path.join(bindingDir(options), "repo.git");
}

export function worktreeParentDir(options: BindingDirOptions): string {
  return path.join(bindingDir(options), "worktrees");
}

export function worktreePath(options: WorktreePathOptions): string {
  return path.join(worktreeParentDir(options), branchDirname(options.branch));
}
