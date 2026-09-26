import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { git, tryGit } from "../../providers/git.ts";
import {
  GithubApiError,
  githubGet,
  githubGetAll,
  githubRequest,
} from "../../providers/github-api.ts";
import type { ResourceState } from "../../workflow/runtime/resources.ts";
import { codexRunStatePath } from "../agents/harnesses/codex-home.ts";
import { piRunStatePath } from "../agents/harnesses/pi-home.ts";
import { fetchOriginDefault } from "../workspaces/create.ts";
import { countUnmergedCommits, isWorktreeDirty } from "../workspaces/teardown.ts";
import type { ResourceRow } from "./registry.ts";
import { runDirectory } from "./run-directory/index.ts";

/**
 * How jigs releases one kind of resource. Explicit and automatic release and prune all
 * go through {@link releaseResource}, so every kind has one set of safety rules.
 *
 * @remarks
 * Handlers read only what jigs itself recorded: the run ID, the identity, and a worktree's
 * clone and branch. A factory-supplied URL never names what gets deleted.
 */
interface ResourceKind {
  /** Why the resource must stay for now, or null when it may be removed. */
  refusal?(row: ResourceRow, run: readonly RunRow[]): Promise<string | null>;
  /** Remove the resource, tolerating one already gone, and say what happened. */
  remove(row: ResourceRow): Promise<string>;
}

/** What a refusal may read about the run's other resources. */
type RunRow = Pick<ResourceRow, "kind" | "state">;

const removeDirectory = (directory: (runId: string) => string): ResourceKind => ({
  async remove(row) {
    await rm(directory(row.runId), { recursive: true, force: true });
    return "removed";
  },
});

const worktree: ResourceKind = {
  async refusal(row) {
    if (row.repoDir === null || row.branch === null) return "not provisioned by jigs";
    if (existsSync(row.identity) && (await isWorktreeDirty(row.identity))) {
      return "uncommitted work kept";
    }
    return null;
  },
  async remove(row) {
    const repoDir = row.repoDir as string;
    const branch = row.branch as string;
    const unmerged = await fetchOriginDefault(repoDir).then(
      () => countUnmergedCommits(repoDir, branch),
      () => null,
    );
    // Forced only when merged, where nothing left in the tree can be lost.
    if (existsSync(row.identity)) {
      await git(
        ["worktree", "remove", row.identity, ...(unmerged === 0 ? ["--force"] : [])],
        repoDir,
      );
    }
    await git(["worktree", "prune"], repoDir);
    if (unmerged !== 0) {
      return unmerged === null
        ? "worktree removed; branch kept because its ancestry could not be verified"
        : `worktree removed; branch kept with ${unmerged} unmerged commit(s)`;
    }
    // Pin and recheck the ref so an independently advanced branch stays.
    const ref = `refs/heads/${branch}`;
    const sha = await tryGit(["rev-parse", "--verify", ref], repoDir);
    if (sha !== null && (await countUnmergedCommits(repoDir, sha)) === 0) {
      await git(["update-ref", "-d", ref, sha], repoDir);
    }
    return "worktree and merged branch removed";
  },
};

interface GithubBranch {
  owner: string;
  repo: string;
  name: string;
  api: string;
}

function githubBranch(identity: string): GithubBranch | null {
  const parsed = /^([^/:]+)\/([^/:]+):(.+)$/.exec(identity);
  if (parsed === null) return null;
  const [, owner = "", repo = "", name = ""] = parsed;
  const encoded = name.split("/").map(encodeURIComponent).join("/");
  return { owner, repo, name, api: `/repos/${owner}/${repo}/git/refs/heads/${encoded}` };
}

const absent = (error: unknown): boolean =>
  error instanceof GithubApiError && (error.status === 404 || error.status === 422);

const branch: ResourceKind = {
  async refusal(row) {
    const target = githubBranch(row.identity);
    if (target === null) return "not a GitHub branch identity";
    const { owner, repo, name } = target;
    const head = await githubGet<{ object: { sha: string } }>(
      target.api.replace("/git/refs/", "/git/ref/"),
    ).catch((error: unknown) => {
      if (absent(error)) return null;
      throw error;
    });
    if (head === null) return null;
    const sha = head.object.sha;
    const pulls = await githubGetAll<{
      number: number;
      state: string;
      merged_at: string | null;
      head: { ref: string; sha: string };
    }>(`/repos/${owner}/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${name}`)}`);
    const own = pulls.filter((pull) => pull.head.ref === name);
    const open = own.find((pull) => pull.state === "open");
    if (open !== undefined) return `pull request #${open.number} is still open`;
    // A squash merge leaves the branch's commits off the default branch, so a
    // merged pull request at this exact head is the other proof of merged work.
    if (own.some((pull) => pull.merged_at !== null && pull.head.sha === sha)) return null;
    const { default_branch } = await githubGet<{ default_branch: string }>(
      `/repos/${owner}/${repo}`,
    );
    const { ahead_by } = await githubGet<{ ahead_by: number }>(
      `/repos/${owner}/${repo}/compare/${encodeURIComponent(default_branch)}...${sha}`,
    );
    return ahead_by === 0 ? null : `${ahead_by} commit(s) are not on ${default_branch}`;
  },
  async remove(row) {
    const target = githubBranch(row.identity) as GithubBranch;
    try {
      await githubRequest("DELETE", target.api);
      return "deleted on GitHub";
    } catch (error) {
      if (absent(error)) return "already absent on GitHub";
      throw error;
    }
  },
};

// Harness homes hold the agent sessions that resume work in a kept worktree.
const harnessHome = (directory: (runId: string) => string): ResourceKind => ({
  ...removeDirectory(directory),
  async refusal(_row, run) {
    const kept = run.some((other) => other.kind === "worktree" && other.state !== "released");
    return kept ? "kept with the run's worktree" : null;
  },
});

// Release visits kinds in this order, so a worktree's outcome is known before
// the harness homes that depend on it.
const KINDS: Record<string, ResourceKind> = {
  worktree,
  branch,
  "run-directory": removeDirectory((runId) => runDirectory({ workflowRunId: runId })),
  "codex-home": harnessHome((runId) => codexRunStatePath(runId)),
  "pi-home": harnessHome((runId) => piRunStatePath(runId)),
};

/** Whether jigs can release this kind; pull requests and factory kinds are recorded only. */
export const releasable = (kind: string): boolean => Object.hasOwn(KINDS, kind);

/** Order rows the way release must visit them, recorded-only kinds last. */
export const releaseOrder = (rows: readonly ResourceRow[]): ResourceRow[] => {
  const order = Object.keys(KINDS);
  const rank = (kind: string) => (releasable(kind) ? order.indexOf(kind) : order.length);
  return rows.toSorted((left, right) => rank(left.kind) - rank(right.kind));
};

export interface ReleaseOutcome {
  state: Exclude<ResourceState, "live">;
  reason: string;
}

/** Why release would keep this resource right now, or null when it would remove it. */
export async function releaseRefusal(
  row: ResourceRow,
  run: readonly RunRow[],
): Promise<string | null> {
  return (await KINDS[row.kind]?.refusal?.(row, run)) ?? null;
}

/**
 * Remove one releasable resource unless a safety check keeps it; errors become `failed`.
 * `run` is every resource of the same run, with states as they stand now.
 */
export async function releaseResource(
  row: ResourceRow,
  run: readonly RunRow[],
): Promise<ReleaseOutcome> {
  const kind = KINDS[row.kind];
  if (kind === undefined) return { state: "kept", reason: "recorded only" };
  try {
    const refusal = await releaseRefusal(row, run);
    if (refusal !== null) return { state: "kept", reason: refusal };
    return { state: "released", reason: await kind.remove(row) };
  } catch (error) {
    return {
      state: "failed",
      reason: `release failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
