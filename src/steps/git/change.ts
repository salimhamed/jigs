import {
  type ChangePatch,
  type ChangeSummary,
  parseNameStatus,
  parseNumstat,
} from "../../blocks/git/change.ts";
import { JigsError } from "../../errors.ts";
import { git } from "../../providers/git.ts";

export const MAX_CHANGE_FILES = 1_000;
export const MAX_CHANGE_COMMITS = 1_000;
export const MAX_PATCH_CHARS = 200_000;

function resolveCommit(worktreePath: string, ref: string): Promise<string> {
  return git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], worktreePath);
}

/**
 * Describe committed changes between a base ref and the worktree's current HEAD.
 *
 * @remarks
 * Resolves both endpoints once, compares their trees directly and lists commits reachable only
 * from HEAD. Returns at most 1,000 files and 1,000 commits; `truncated` reports omitted results.
 */
export async function readChange(worktreePath: string, base: string): Promise<ChangeSummary> {
  const [baseSha, head] = await Promise.all([
    resolveCommit(worktreePath, base),
    resolveCommit(worktreePath, "HEAD"),
  ]);
  const diff = ["diff", "--no-ext-diff", "--no-textconv", "--find-renames"];
  const [names, stats, log] = await Promise.all([
    git([...diff, "--name-status", "-z", baseSha, head, "--"], worktreePath),
    git([...diff, "--numstat", "-z", baseSha, head, "--"], worktreePath),
    git(
      [
        "log",
        `--max-count=${MAX_CHANGE_COMMITS + 1}`,
        "-z",
        "--format=%H%x00%s%x00%an",
        `${baseSha}..${head}`,
        "--",
      ],
      worktreePath,
    ),
  ]);
  const files = parseNameStatus(names);
  const counts = new Map(parseNumstat(stats).map((file) => [file.path, file]));
  const fields = log.split("\0");
  const commits: ChangeSummary["commits"] = [];
  for (let i = 0; i < fields.length - 1; i += 3) {
    commits.push({
      sha: fields[i] ?? "",
      subject: fields[i + 1] ?? "",
      authorName: fields[i + 2] ?? "",
    });
  }
  return {
    base: baseSha,
    head,
    files: files.slice(0, MAX_CHANGE_FILES).map((file) => ({
      ...file,
      additions: counts.get(file.path)?.additions ?? 0,
      deletions: counts.get(file.path)?.deletions ?? 0,
    })),
    commits: commits.slice(0, MAX_CHANGE_COMMITS),
    truncated: files.length > MAX_CHANGE_FILES || commits.length > MAX_CHANGE_COMMITS,
  };
}

/**
 * Read patches for selected literal paths between two commits.
 *
 * @remarks
 * Pass the resolved `base` and `head` from `readChange` to inspect that exact change. Paths are
 * deduplicated, empty paths are rejected and all returned patches share a 200,000-character limit.
 */
export async function readPatch(
  worktreePath: string,
  base: string,
  head: string,
  paths: string[],
): Promise<ChangePatch> {
  if (paths.length === 0 || paths.some((path) => path.length === 0)) {
    throw new JigsError(
      "readPatch requires named paths",
      "Pass one or more nonempty file paths from readChange().files.",
    );
  }
  const [baseSha, headSha] = await Promise.all([
    resolveCommit(worktreePath, base),
    resolveCommit(worktreePath, head),
  ]);
  const patches: ChangePatch["patches"] = [];
  let remaining = MAX_PATCH_CHARS;
  let truncated = false;
  for (const path of [...new Set(paths)]) {
    // Disable renames so a selected new path cannot pull in an unselected old path.
    const text = await git(
      [
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        baseSha,
        headSha,
        "--",
        path,
      ],
      worktreePath,
    );
    patches.push({ path, text: text.slice(0, remaining) });
    if (text.length > remaining) truncated = true;
    remaining = Math.max(0, remaining - text.length);
  }
  return { patches, truncated };
}
