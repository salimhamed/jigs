import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { CLONE_INSTALLATION_KEY, git, remoteGit, tryGit } from "../../providers/git.ts";

// jigs' own bare clone of a binding's remote, which every worktree of that
// binding is cut from. Built with `init --bare` + `remote add` + `fetch`
// rather than `clone --bare` or `--mirror`, because only that route leaves
// `refs/remotes/origin/*` as the mirror of the remote while `refs/heads/*`
// stays jigs' own run-branch namespace — the two namespaces the three-way
// branch resolution reads as distinct.

export interface EnsureBindingCloneOptions {
  repoDir: string;
  /** The repository's https://github.com URL, which carries no credential. */
  url: string;
  installationName: string;
}

// `remote set-head` runs last, so this ref is what says every step below
// finished. A symbolic ref is never packed, so its file is the whole test.
export function hasBindingClone(repoDir: string): boolean {
  return existsSync(path.join(repoDir, "refs", "remotes", "origin", "HEAD"));
}

// Each step is a no-op against the state the one before it leaves, so a clone
// interrupted anywhere resumes into the objects already on disk rather than
// downloading them again. Origin and the installation are set every time, so
// editing a binding's `remote:` or `installationName:` repoints the clone it
// already has.
export async function ensureBindingClone(options: EnsureBindingCloneOptions): Promise<void> {
  const { repoDir, url, installationName } = options;
  const cloned = hasBindingClone(repoDir);
  if (!cloned) {
    mkdirSync(path.dirname(repoDir), { recursive: true });
    await git(["init", "--bare", "--quiet", repoDir], path.dirname(repoDir));
  }
  await pointOriginAt(repoDir, url);
  await git(["config", CLONE_INSTALLATION_KEY, installationName], repoDir);
  if (cloned) return;
  await remoteGit(["fetch", "--quiet", "origin"], repoDir);
  await remoteGit(["remote", "set-head", "origin", "--auto"], repoDir);
}

// `remote add` writes +refs/heads/*:refs/remotes/origin/* itself, which is
// exactly the refspec wanted; never widen it.
async function pointOriginAt(repoDir: string, url: string): Promise<void> {
  const current = await tryGit(["config", "remote.origin.url"], repoDir);
  if (current === null) {
    await git(["remote", "add", "origin", url], repoDir);
  } else if (current !== url) {
    await git(["remote", "set-url", "origin", url], repoDir);
  }
}
