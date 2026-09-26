import { deriveDefaultBranch, tryGit } from "../../providers/git.ts";

// Commits the branch holds that origin's default branch does not: zero is the
// merged answer, and null is no answer at all — an unresolvable default branch
// or ref, which callers read as unmerged because branch deletion needs
// positive evidence.
export async function countUnmergedCommits(
  repoDir: string,
  branch: string,
): Promise<number | null> {
  const defaultBranch = await deriveDefaultBranch(repoDir);
  if (defaultBranch === null) return null;
  const trackingRef = `refs/remotes/origin/${defaultBranch}`;
  const localDefault = await tryGit(["rev-parse", "--verify", trackingRef], repoDir);
  const remoteHead = await tryGit(["ls-remote", "--symref", "origin", "HEAD"], repoDir);
  if (localDefault === null || remoteHead === null) return null;
  const remoteLines = remoteHead.split("\n").filter(Boolean);
  if (remoteLines.length !== 2) return null;
  const symbolic = remoteLines
    .find((line) => line.startsWith("ref:"))
    ?.trim()
    .split(/\s+/);
  const oid = remoteLines
    .filter((line) => !line.startsWith("ref:"))
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === "HEAD");
  if (
    symbolic?.length !== 3 ||
    symbolic[0] !== "ref:" ||
    symbolic[1] !== `refs/heads/${defaultBranch}` ||
    symbolic[2] !== "HEAD" ||
    oid?.length !== 2 ||
    oid[0] !== localDefault
  ) {
    return null;
  }
  const count = await tryGit(["rev-list", "--count", branch, `^${trackingRef}`], repoDir);
  if (count === null) return null;
  const commits = Number(count);
  return count.trim() !== "" && Number.isInteger(commits) && commits >= 0 ? commits : null;
}

export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const status = await tryGit(["status", "--porcelain"], worktreePath);
  return status === null || status !== "";
}
