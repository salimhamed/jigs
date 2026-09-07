import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  parseFactoryConfig,
  readFactoryConfigText,
} from "../config/factory-config.ts";
import { JigsError } from "../errors.ts";
import { git, tryGit } from "../git.ts";
import { bindingRepoDir } from "./layout.ts";

// jigs' own bare clone of a binding's remote, which every worktree of that
// binding is cut from (ADR 0006). Built with `init --bare` + `remote add` +
// `fetch` rather than `clone --bare` or `--mirror`, because only that route
// leaves `refs/remotes/origin/*` as the mirror of the remote while
// `refs/heads/*` stays jigs' own run-branch namespace — the two namespaces the
// three-way branch resolution reads as distinct.

export interface EnsureBindingCloneOptions {
  repoDir: string;
  remote: string;
}

export interface BindingClone {
  name: string;
  remote: string;
  repoDir: string;
}

// What the service's startup gate clones, in one call: every binding the
// factory declares, with the directory its clone belongs in.
export function bindingClones(factoryRoot: string): BindingClone[] {
  const { bindings } = parseFactoryConfig(readFactoryConfigText(factoryRoot));
  return Object.entries(bindings).map(([name, binding]) => ({
    name,
    remote: binding.remote,
    repoDir: bindingRepoDir({ factoryRoot, bindingName: name }),
  }));
}

// `remote set-head` runs last, so this ref is what says every step below
// finished. A symbolic ref is never packed, so its file is the whole test.
export function hasBindingClone(repoDir: string): boolean {
  return existsSync(path.join(repoDir, "refs", "remotes", "origin", "HEAD"));
}

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// Four steps, each a no-op against the state the one before it leaves, so a
// clone interrupted anywhere resumes into the objects already on disk rather
// than downloading them again. A directory already at repoDir is adopted on
// purpose rather than refused: every step is idempotent, so whatever a killed
// attempt left is exactly what the next one builds on.
export async function ensureBindingClone(
  options: EnsureBindingCloneOptions,
): Promise<void> {
  const { repoDir, remote } = options;
  const parent = path.dirname(repoDir);
  try {
    if (hasBindingClone(repoDir)) {
      await pointOriginAt(repoDir, remote);
      return;
    }
    mkdirSync(parent, { recursive: true });
    await git(["init", "--bare", "--quiet", repoDir], parent);
    await pointOriginAt(repoDir, remote);
    await fetchOrigin(repoDir, remote);
    // Last, so nothing before it can be mistaken for a finished clone.
    await git(["remote", "set-head", "origin", "--auto"], repoDir);
  } catch (err) {
    // The fetch has already said the one thing an operator can act on;
    // everything else fails for a reason no credential fixes.
    if (err instanceof JigsError) throw err;
    throw new JigsError(
      `could not prepare the clone of ${remote} at ${repoDir}: ${reason(err)}`,
    );
  }
}

async function fetchOrigin(repoDir: string, remote: string): Promise<void> {
  try {
    await git(["fetch", "--quiet", "origin"], repoDir);
  } catch (err) {
    throw new JigsError(
      `could not fetch ${remote}: ${reason(err)}`,
      `give git credentials for ${remote} — an ssh key the service can read, or GITHUB_TOKEN for an https remote`,
    );
  }
}

// `remote add` writes +refs/heads/*:refs/remotes/origin/* itself, which is
// exactly the refspec wanted; never widen it. --end-of-options because the
// remote is a config-supplied string in a positional slot. Editing a binding's
// `remote:` repoints the clone it already has.
async function pointOriginAt(repoDir: string, remote: string): Promise<void> {
  const url = await tryGit(["remote", "get-url", "origin"], repoDir);
  if (url === null) {
    await git(["remote", "add", "--end-of-options", "origin", remote], repoDir);
  } else if (url !== remote) {
    await git(
      ["remote", "set-url", "--end-of-options", "origin", remote],
      repoDir,
    );
  }
}
