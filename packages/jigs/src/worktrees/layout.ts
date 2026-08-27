import { createHash } from "node:crypto";
import path from "node:path";
import { expandHome, jigsDataDir } from "../paths.ts";

// Binding names are unique only per factory repo, so the path needs factory
// identity — dirname alone would collide two factories named the same.
export function factorySlug(factoryRoot: string): string {
  const resolved = path.resolve(factoryRoot);
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${path.basename(resolved)}-${hash}`;
}

export function branchDirname(branch: string): string {
  return branch.replaceAll("/", "-");
}

export interface WorktreePathOptions {
  factoryRoot: string;
  bindingName: string;
  branch: string;
  workspaceDir?: string;
  baseDir?: string;
}

// The directory a binding's worktrees all sit directly under — what the
// sweep scans to find directories the registry never heard of.
export function worktreeParentDir(
  options: Omit<WorktreePathOptions, "branch">,
): string {
  if (options.workspaceDir !== undefined) {
    return expandHome(options.workspaceDir);
  }
  const base = options.baseDir ?? path.join(jigsDataDir(), "worktrees");
  return path.join(base, factorySlug(options.factoryRoot), options.bindingName);
}

export function worktreePath(options: WorktreePathOptions): string {
  return path.join(worktreeParentDir(options), branchDirname(options.branch));
}
