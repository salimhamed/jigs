import path from "node:path";
import { factorySlug, jigsDataDir } from "../../config/paths.ts";

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
