import { deriveDefaultBranch, git, tryGit } from "../git.ts";
import { checkoutLockPath, withFileLock } from "./lock.ts";

// Guarded fast-forward of the binding checkout's local default branch
// (ADR 0007): default-on, pure-ff only, clean checkout only. Anything else
// skips. This module never throws — the caller logs the notice, so "skips
// with a notice, never an error" is structural rather than remembered.

export type FfSkip =
  | "disabled"
  | "dirty"
  | "not-fast-forward"
  | "already-current"
  | "no-default-branch"
  | "error";

export interface FfResult {
  moved: boolean;
  from?: string;
  to?: string;
  skipped?: FfSkip;
  detail?: string;
}

export interface FastForwardOptions {
  checkoutRoot: string;
  enabled?: boolean;
  lockPath?: string;
}

export function ffLockPath(checkoutRoot: string): string {
  return checkoutLockPath(checkoutRoot, "ff");
}

export function describeFf(checkoutRoot: string, result: FfResult): string {
  if (result.moved) {
    return `fast-forwarded the default branch of ${checkoutRoot}: ${result.from?.slice(0, 8)} → ${result.to?.slice(0, 8)}`;
  }
  const detail = result.detail === undefined ? "" : ` (${result.detail})`;
  return `skipped the default-branch fast-forward of ${checkoutRoot}: ${result.skipped}${detail}`;
}

export async function fastForwardDefaultBranch(
  options: FastForwardOptions,
): Promise<FfResult> {
  const { checkoutRoot } = options;
  if (options.enabled === false) return { moved: false, skipped: "disabled" };
  try {
    return await withFileLock(
      options.lockPath ?? ffLockPath(checkoutRoot),
      () => attempt(checkoutRoot),
    );
  } catch (err) {
    return { moved: false, skipped: "error", detail: String(err) };
  }
}

async function attempt(checkoutRoot: string): Promise<FfResult> {
  const defaultBranch = await deriveDefaultBranch(checkoutRoot);
  if (defaultBranch === null) {
    return { moved: false, skipped: "no-default-branch" };
  }
  const dirt = await git(["status", "--porcelain"], checkoutRoot);
  if (dirt !== "") {
    return {
      moved: false,
      skipped: "dirty",
      detail: `${dirt.split("\n").length} changed path(s)`,
    };
  }
  await git(["fetch", "origin", defaultBranch], checkoutRoot);

  const local = await tryGit(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${defaultBranch}`],
    checkoutRoot,
  );
  const remote = await git(
    ["rev-parse", `refs/remotes/origin/${defaultBranch}`],
    checkoutRoot,
  );
  if (local === null) {
    // No local default branch to move — the fetch already refreshed the
    // remote-tracking ref, which is what freshness actually reads.
    return { moved: false, skipped: "already-current" };
  }
  if (local === remote) return { moved: false, skipped: "already-current" };

  const ancestor = await tryGit(
    ["merge-base", "--is-ancestor", local, remote],
    checkoutRoot,
  );
  if (ancestor === null) {
    return {
      moved: false,
      skipped: "not-fast-forward",
      detail: `local ${defaultBranch} holds commits origin does not`,
    };
  }

  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], checkoutRoot);
  if (head === defaultBranch) {
    await git(["pull", "--ff-only", "origin", defaultBranch], checkoutRoot);
  } else {
    // git itself refuses a non-ff update of a local ref through fetch — a
    // second belt behind the is-ancestor check above.
    await git(
      ["fetch", "origin", `${defaultBranch}:${defaultBranch}`],
      checkoutRoot,
    );
  }
  return { moved: true, from: local, to: remote };
}
