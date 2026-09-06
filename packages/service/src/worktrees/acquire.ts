import type { WorktreeFacts } from "jigs";
import type { Sql } from "postgres";
import { getRun } from "workflow/api";
import { createWorktree, worktreeStatus } from "./create";
import { getWorktree, upsertWorktree } from "./registry";
import { decideReuse, WorktreeOwnedError } from "./reuse";

// The SDK has no `suspended` status — a parked run reads `running` — so
// non-terminal covers live and suspended owners alike (a suspended run
// holds its worktree).
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export interface OwnerState {
  terminal: boolean;
  status: string;
}

// A run the world no longer knows about is as terminal as one that finished:
// nothing will ever come back for its worktree.
export async function readOwner(runId: string): Promise<OwnerState> {
  const run = getRun(runId);
  if (!(await run.exists)) return { terminal: true, status: "unknown" };
  const status = await run.status;
  return { terminal: TERMINAL_RUN_STATUSES.has(status), status };
}

async function runIsLive(runId: string): Promise<boolean> {
  return !(await readOwner(runId)).terminal;
}

export interface AcquireWorktreeRequest {
  runId: string;
  repoDir: string;
  worktreePath: string;
  branch: string;
  keep?: boolean;
}

export interface AcquireWorktreeDeps {
  sql: Sql;
  runIsLive?: (runId: string) => Promise<boolean>;
  worktreeStatus?: typeof worktreeStatus;
  createWorktree?: typeof createWorktree;
}

export async function acquireWorktree(
  request: AcquireWorktreeRequest,
  deps: AcquireWorktreeDeps,
): Promise<WorktreeFacts> {
  const isLive = deps.runIsLive ?? runIsLive;
  const status = deps.worktreeStatus ?? worktreeStatus;
  const create = deps.createWorktree ?? createWorktree;

  // Per-path advisory lock: without it, two concurrent acquires for the same
  // unowned path both read no live owner during the (fetch-long) window
  // between getWorktree and upsertWorktree, and the loser silently steals
  // ownership. The loser now blocks here, then sees the winner's row.
  return deps.sql.begin(async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${request.worktreePath}))`;

    const row = await getWorktree(sql, request.worktreePath);
    const registration =
      row === null
        ? null
        : {
            ownerRunId: row.ownerRunId,
            ownerLive: await isLive(row.ownerRunId),
          };
    // Refuse before touching disk: worktreeStatus fetches, and a foreign live
    // owner should never surface as a network error or pay for the fetch.
    if (registration?.ownerLive && registration.ownerRunId !== request.runId) {
      throw new WorktreeOwnedError(
        request.worktreePath,
        registration.ownerRunId,
      );
    }

    const disk = await status({
      repoDir: request.repoDir,
      worktreePath: request.worktreePath,
      branch: request.branch,
    });
    decideReuse({
      path: request.worktreePath,
      registration,
      requestingRunId: request.runId,
      disk,
    });

    const facts: WorktreeFacts =
      disk === null
        ? await create({
            repoDir: request.repoDir,
            worktreePath: request.worktreePath,
            branch: request.branch,
          })
        : {
            path: request.worktreePath,
            branch: request.branch,
            resolution: "local",
            defaultBranch: disk.defaultBranch,
            baseSha: disk.baseSha,
            headSha: disk.headSha,
            behindDefault: disk.behindDefault,
          };

    await upsertWorktree(sql, {
      path: facts.path,
      branch: facts.branch,
      ownerRunId: request.runId,
      state: "active",
      baseSha: facts.baseSha,
      headSha: facts.headSha,
      behindDefault: facts.behindDefault,
      repoDir: request.repoDir,
      keep: request.keep === true,
    });
    return facts;
  });
}
