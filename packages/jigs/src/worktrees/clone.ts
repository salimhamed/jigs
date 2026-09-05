import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { CliError } from "../errors.ts";
import { git, tryGit } from "../git.ts";
import { lockPathFor, withFileLock } from "./lock.ts";

// jigs' own bare clone of a binding's remote, which every worktree of that
// binding is cut from (ADR 0006). Built with `init --bare` + `remote add` +
// `fetch` rather than `clone --bare` or `--mirror`, because only that route
// leaves `refs/remotes/origin/*` as the mirror of the remote while
// `refs/heads/*` stays jigs' own run-branch namespace — the two namespaces the
// three-way branch resolution reads as distinct.

// A first fetch of a large monorepo outlasts the lock's 30s default, and two
// branches' first worktree requests race on it. The bound on that fetch is
// staleMs, 30 minutes — the 15-minute timeout is only how long a *waiter*
// gives up after. A lock stolen at staleMs may then delete a partial the
// original holder is still writing.
const CLONE_LOCK_TIMEOUT_MS = 900_000;
const CLONE_LOCK_STALE_MS = 1_800_000;

export interface EnsureBindingCloneOptions {
  repoDir: string;
  remote: string;
}

export async function ensureBindingClone(
  options: EnsureBindingCloneOptions,
): Promise<void> {
  const { repoDir, remote } = options;
  if (await repointExisting(repoDir, remote)) return;
  await withFileLock(
    lockPathFor(repoDir, "clone"),
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
    await git(["remote", "add", "--end-of-options", "origin", remote], repoDir);
  } else if (url !== remote) {
    await git(
      ["remote", "set-url", "--end-of-options", "origin", remote],
      repoDir,
    );
  }
  return true;
}

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

async function buildClone(repoDir: string, remote: string): Promise<void> {
  // Past repointExisting, so a directory here has no HEAD: renameSync onto a
  // non-empty one fails with ENOTEMPTY every time, and the operator needs to
  // hear that rather than "could not clone". An empty one renames fine.
  if (existsSync(repoDir) && readdirSync(repoDir).length > 0) {
    throw new CliError(
      `the clone at ${repoDir} is unfinished — it has no HEAD`,
      `remove it and let the next worktree request rebuild it: rm -rf ${repoDir}`,
    );
  }
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
    // exactly the refspec wanted; never widen it. --end-of-options because the
    // remote is a config-supplied string in a positional slot.
    await git(["remote", "add", "--end-of-options", "origin", remote], partial);
    try {
      await git(["fetch", "--quiet", "origin"], partial);
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
