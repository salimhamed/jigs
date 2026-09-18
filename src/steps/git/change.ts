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

/** Read the direct base-to-head tree difference and commits unique to head. */
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
        "--format=%H%x00%s",
        `${baseSha}..${head}`,
        "--",
      ],
      worktreePath,
    ),
  ]);
  const files = parseNameStatus(names);
  const counts = new Map(parseNumstat(stats).map((file) => [file.path, file]));
  const commits =
    log === ""
      ? []
      : log.split("\n").map((line) => {
          const separator = line.indexOf("\0");
          return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
        });
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

/** Read literal named paths between two commits, with a shared text budget. */
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
