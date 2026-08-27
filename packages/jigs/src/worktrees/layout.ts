import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { expandHome } from "../paths.ts";

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

export function worktreePath(options: WorktreePathOptions): string {
  const dirname = branchDirname(options.branch);
  if (options.workspaceDir !== undefined) {
    return path.join(expandHome(options.workspaceDir), dirname);
  }
  const base =
    options.baseDir ??
    path.join(
      process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"),
      "jigs",
      "worktrees",
    );
  return path.join(
    base,
    factorySlug(options.factoryRoot),
    options.bindingName,
    dirname,
  );
}
