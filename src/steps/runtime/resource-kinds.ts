import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { git, tryGit } from "../../providers/git.ts";
import {
  RELEASABLE_KINDS,
  type ReleasableKind,
  type ResourceState,
  releasable,
} from "../../workflow/runtime/resources.ts";
import { codexRunStatePath } from "../agents/harnesses/codex-home.ts";
import { piRunStatePath } from "../agents/harnesses/pi-home.ts";
import { fetchOriginDefault } from "../workspaces/create.ts";
import { countUnmergedCommits, isWorktreeDirty } from "../workspaces/git-safety.ts";
import type { ResourceRow } from "./registry.ts";
import { runDirectory } from "./run-directory/index.ts";

interface ReleaseOutcome {
  state: Exclude<ResourceState, "failed">;
  reason: string;
}

/** What release would do now: leave the resource with a reason, or run the removal. */
export type ReleaseDecision = ReleaseOutcome | (() => Promise<ReleaseOutcome>);

/** What a decision may read about the run's other resources, as they stand now. */
type RunResourceState = Pick<ResourceRow, "kind" | "state">;

/**
 * How jigs releases one kind of resource. Explicit and automatic release and prune all go
 * through {@link decideRelease}, so every kind has one set of safety rules.
 *
 * @remarks
 * Only jigs records these kinds (`registerResource` refuses them), and handlers read only what
 * it recorded: the run ID, the identity, and a worktree's clone and branch. A decision's checks
 * change nothing; the removal it returns acts on exactly what they checked.
 */
type ResourceKind = (
  row: ResourceRow,
  run: readonly RunResourceState[],
) => Promise<ReleaseDecision>;

const keep = (reason: string): ReleaseOutcome => ({ state: "kept", reason });
const released = (reason: string): ReleaseOutcome => ({ state: "released", reason });

const removeDirectory =
  (directory: (runId: string) => string): ResourceKind =>
  async (row) =>
  async () => {
    await rm(directory(row.runId), { recursive: true, force: true });
    return released("removed");
  };

function worktreeOf(row: ResourceRow): { path: string; repoDir: string; branch: string } {
  if (row.repoDir === null || row.branch === null) {
    throw new Error(`worktree record ${row.identity} has no clone or branch`);
  }
  return { path: row.identity, repoDir: row.repoDir, branch: row.branch };
}

const worktree: ResourceKind = async (row) => {
  const { path, repoDir, branch } = worktreeOf(row);
  if (existsSync(path) && (await isWorktreeDirty(path))) return keep("uncommitted work kept");
  return async () => {
    const unmerged = await fetchOriginDefault(repoDir).then(
      () => countUnmergedCommits(repoDir, branch),
      () => null,
    );
    // Forced only when merged, where nothing left in the tree can be lost.
    if (existsSync(path)) {
      await git(["worktree", "remove", path, ...(unmerged === 0 ? ["--force"] : [])], repoDir);
    }
    await git(["worktree", "prune"], repoDir);
    if (unmerged !== 0) {
      return released(
        unmerged === null
          ? "worktree removed; branch kept because its ancestry could not be verified"
          : `worktree removed; branch kept with ${unmerged} unmerged commit(s)`,
      );
    }
    // Pin and recheck the ref so an independently advanced branch stays.
    const ref = `refs/heads/${branch}`;
    const sha = await tryGit(["rev-parse", "--verify", ref], repoDir);
    if (sha !== null && (await countUnmergedCommits(repoDir, sha)) === 0) {
      await git(["update-ref", "-d", ref, sha], repoDir);
    }
    return released("worktree and merged branch removed");
  };
};

// Harness homes hold the agent sessions that resume work in the run's worktree,
// so they wait for its outcome and stay when it stays.
const harnessHome =
  (directory: (runId: string) => string): ResourceKind =>
  async (row, run) => {
    const trees = run.filter((other) => other.kind === "worktree");
    if (trees.some((tree) => tree.state === "kept")) return keep("kept with the run's worktree");
    if (trees.some((tree) => tree.state !== "released")) {
      return { state: "live", reason: "waits for the run's worktree" };
    }
    return removeDirectory(directory)(row, run);
  };

// Release visits kinds in RELEASABLE_KINDS order, so a worktree's outcome is
// known before the harness homes that depend on it.
const KINDS: Record<ReleasableKind, ResourceKind> = {
  worktree,
  "run-directory": removeDirectory((runId) => runDirectory({ workflowRunId: runId })),
  "codex-home": harnessHome((runId) => codexRunStatePath(runId)),
  "pi-home": harnessHome((runId) => piRunStatePath(runId)),
};

/** The releasable rows, in the order release must visit them; recorded-only kinds are left out. */
export const releaseOrder = (rows: readonly ResourceRow[]): ResourceRow[] => {
  const rank = (kind: string) => (RELEASABLE_KINDS as readonly string[]).indexOf(kind);
  return rows.filter((row) => releasable(row.kind)).toSorted((a, b) => rank(a.kind) - rank(b.kind));
};

/** Decide what release would do with one releasable resource, changing nothing. */
export async function decideRelease(
  row: ResourceRow,
  run: readonly RunResourceState[],
): Promise<ReleaseDecision> {
  if (!releasable(row.kind)) throw new Error(`jigs does not release ${row.kind} resources`);
  return KINDS[row.kind](row, run);
}
