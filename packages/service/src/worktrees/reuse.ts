export class WorktreeOwnedError extends Error {
  readonly path: string;
  readonly owningRunId: string;

  constructor(path: string, owningRunId: string) {
    super(
      `worktree ${path} is owned by run ${owningRunId} — wait for it, or release it with: jigs cancel ${owningRunId}`,
    );
    this.name = "WorktreeOwnedError";
    this.path = path;
    this.owningRunId = owningRunId;
  }
}

export type NotReusableReason = "dirty" | "diverged" | "wrong-branch";

const REASON_DETAIL: Record<NotReusableReason, string> = {
  dirty: "has uncommitted changes",
  diverged: "has diverged from its remote branch",
  "wrong-branch": "has a different branch checked out",
};

export class WorktreeNotReusableError extends Error {
  readonly path: string;
  readonly reason: NotReusableReason;

  constructor(path: string, reason: NotReusableReason) {
    super(
      `worktree ${path} ${REASON_DETAIL[reason]} — it was preserved untouched; inspect it, then commit or stash the work, or remove it with: git worktree remove ${path}`,
    );
    this.name = "WorktreeNotReusableError";
    this.path = path;
    this.reason = reason;
  }
}

export interface ReuseDiskFacts {
  branchMatches: boolean;
  clean: boolean;
  diverged: boolean;
}

export interface ReuseInput {
  path: string;
  sameOwner: boolean;
  disk: ReuseDiskFacts;
}

export function assertReusable(input: ReuseInput): void {
  const { path, sameOwner, disk } = input;
  if (!disk.branchMatches) {
    throw new WorktreeNotReusableError(path, "wrong-branch");
  }
  // The owner's own re-entry reuses as-is: the dirt is the run's own work.
  if (sameOwner) return;
  if (!disk.clean) throw new WorktreeNotReusableError(path, "dirty");
  if (disk.diverged) throw new WorktreeNotReusableError(path, "diverged");
}
