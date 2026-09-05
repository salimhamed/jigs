import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { CliError } from "../errors.ts";
import { git, nonInteractiveGitEnv, tryGit } from "../git.ts";
import { lockPathFor, withFileLock } from "./lock.ts";

// jigs' own bare clone of a binding's remote, which every worktree of that
// binding is cut from (ADR 0006). Built with `init --bare` + `remote add` +
// `fetch` rather than `clone --bare` or `--mirror`, because only that route
// leaves `refs/remotes/origin/*` as the mirror of the remote while
// `refs/heads/*` stays jigs' own run-branch namespace — the two namespaces the
// three-way branch resolution reads as distinct.

// A first fetch of a large monorepo outlasts the lock's 30s default, and two
// branches' first worktree requests race on it.
const CLONE_LOCK_TIMEOUT_MS = 900_000;
const CLONE_LOCK_STALE_MS = 1_800_000;

export interface EnsureBindingCloneOptions {
  repoDir: string;
  remote: string;
  lockPath?: string;
}

export async function ensureBindingClone(
  options: EnsureBindingCloneOptions,
): Promise<void> {
  const { repoDir, remote } = options;
  if (await repointExisting(repoDir, remote)) return;
  await withFileLock(
    options.lockPath ?? lockPathFor(repoDir, "clone"),
    async () => {
      if (await repointExisting(repoDir, remote)) return;
      await buildClone(repoDir, remote);
    },
    { timeoutMs: CLONE_LOCK_TIMEOUT_MS, staleMs: CLONE_LOCK_STALE_MS },
  );
}

// HEAD rather than the directory: a clone is built in a sibling and renamed
// into place, so HEAD is what says the one here finished. Editing a binding's
// `remote:` repoints the clone it already has.
async function repointExisting(
  repoDir: string,
  remote: string,
): Promise<boolean> {
  if (!existsSync(path.join(repoDir, "HEAD"))) return false;
  const url = await tryGit(["remote", "get-url", "origin"], repoDir);
  if (url === null) {
    await git(["remote", "add", "origin", remote], repoDir);
  } else if (url !== remote) {
    await git(["remote", "set-url", "origin", remote], repoDir);
  }
  return true;
}

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

async function buildClone(repoDir: string, remote: string): Promise<void> {
  const parent = path.dirname(repoDir);
  mkdirSync(parent, { recursive: true });
  const prefix = `${path.basename(repoDir)}.partial-`;
  // Every pid's leftovers, not just this process's: a hard kill mid-clone
  // leaves a partial nothing else would ever reclaim. Safe under the lock,
  // which is the only thing that builds one.
  for (const entry of readdirSync(parent)) {
    if (entry.startsWith(prefix)) {
      rmSync(path.join(parent, entry), { recursive: true, force: true });
    }
  }

  const partial = path.join(parent, `${prefix}${process.pid}`);
  try {
    await git(["init", "--bare", "--quiet", partial], parent);
    // `remote add` writes +refs/heads/*:refs/remotes/origin/* itself, which is
    // exactly the refspec wanted; never widen it.
    await git(["remote", "add", "origin", remote], partial);
    try {
      await git(
        ["fetch", "--quiet", "origin"],
        partial,
        nonInteractiveGitEnv(),
      );
    } catch (err) {
      // The one step that can fail for a reason the operator can act on.
      throw new CliError(
        `could not fetch ${remote}: ${reason(err)}`,
        `give git credentials for ${remote} — an ssh key the service can read, or GITHUB_TOKEN for an https remote`,
      );
    }
    await git(["remote", "set-head", "origin", "--auto"], partial);
    renameSync(partial, repoDir);
  } catch (err) {
    rmSync(partial, { recursive: true, force: true });
    if (err instanceof CliError) throw err;
    throw new CliError(
      `could not clone ${remote} into ${repoDir}: ${reason(err)}`,
    );
  }
}
