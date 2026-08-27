import {
  createWorktree,
  decideReuse,
  type WorktreeFacts,
  type WorktreeStatus,
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

  const row = await getWorktree(deps.sql, request.worktreePath);
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

  const facts =
    decision.action === "create"
      ? await create({
          checkoutRoot: request.checkoutRoot,
          worktreePath: request.worktreePath,
          branch: request.branch,
        })
      : reuseFacts(request, disk);

  await upsertWorktree(deps.sql, {
    path: facts.path,
    branch: facts.branch,
    ownerRunId: request.runId,
    state: "active",
    baseSha: facts.baseSha,
    headSha: facts.headSha,
    behindDefault: facts.behindDefault,
  });
  return facts;
}

function reuseFacts(
  request: AcquireWorktreeRequest,
  disk: WorktreeStatus,
): WorktreeFacts {
  if (
    disk.headSha === null ||
    disk.behindDefault === null ||
    disk.defaultBranch === null ||
    disk.baseSha === null
  ) {
    throw new Error(
      `worktree ${request.worktreePath} was decided reusable without disk facts`,
    );
  }
  return {
    path: request.worktreePath,
    branch: request.branch,
    resolution: "local",
    defaultBranch: disk.defaultBranch,
    baseSha: disk.baseSha,
    headSha: disk.headSha,
    behindDefault: disk.behindDefault,
  };
}
