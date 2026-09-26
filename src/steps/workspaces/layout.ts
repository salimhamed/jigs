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

export interface CloneDirOptions {
  factoryRoot: string;
  bindingName: string;
}

export interface WorktreePathOptions extends CloneDirOptions {
  branch: string;
}

/**
 * The directory holding every binding clone and its worktrees for one factory.
 * It is separate from the factory repo's own `bindings/<name>/` folders.
 */
export function factoryClonesDir(factoryRoot: string, dataDir: string = jigsDataDir()): string {
  return path.join(dataDir, "clones", factorySlug(factoryRoot));
}

// Everything a binding owns is co-located, so "where does this binding live"
// has one answer that `du -sh` prices and `rm -rf` resets.
export function cloneDir(options: CloneDirOptions): string {
  return path.join(factoryClonesDir(options.factoryRoot), options.bindingName);
}

/** The factory repo's folder of files a binding's `copy` lists, distinct from its {@link cloneDir}. */
export function bindingFilesDir(factoryRoot: string, bindingName: string): string {
  return path.join(factoryRoot, "bindings", bindingName);
}

export function cloneRepoDir(options: CloneDirOptions): string {
  return path.join(cloneDir(options), "repo.git");
}

export function worktreeParentDir(options: CloneDirOptions): string {
  return path.join(cloneDir(options), "worktrees");
}

export function worktreePath(options: WorktreePathOptions): string {
  return path.join(worktreeParentDir(options), branchDirname(options.branch));
}
