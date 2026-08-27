import {
  createWorktree,
  decideReuse,
  type WorktreeFacts,
  worktreeStatus,
} from "jigs";
import type { Sql } from "postgres";
import { getRun } from "workflow/api";
import { getWorktree, upsertWorktree } from "./registry";

// The SDK has no `suspended` status — a parked run reads `running` — so
// non-terminal covers live and suspended owners alike (a suspended run
// holds its worktree).
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

async function runIsLive(runId: string): Promise<boolean> {
  const run = getRun(runId);
  if (!(await run.exists)) return false;
  return !TERMINAL_RUN_STATUSES.has(await run.status);
}

export interface AcquireWorktreeRequest {
  runId: string;
  checkoutRoot: string;
  worktreePath: string;
  branch: string;
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
    const disk = await status({
      checkoutRoot: request.checkoutRoot,
      worktreePath: request.worktreePath,
      branch: request.branch,
    });
    const decision = decideReuse({
      path: request.worktreePath,
      registration,
      requestingRunId: request.runId,
      disk,
    });

    // decideReuse returns "create" only when disk is null; the second arm of
    // the condition is for narrowing.
    const facts: WorktreeFacts =
      decision === "create" || disk === null
        ? await create({
            checkoutRoot: request.checkoutRoot,
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
    });
    return facts;
  });
}
