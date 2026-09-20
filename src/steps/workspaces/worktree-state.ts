import { existsSync } from "node:fs";
import type { OwnerState } from "./owner.ts";
import { readOwner } from "./owner.ts";
import { listWorktrees, type RegistrySql } from "./registry.ts";
import { isWorktreeDirty } from "./teardown.ts";

export type WorktreeState =
  | "held"
  | "abandoned"
  | "abandoned-dirty"
  | "provision-failed"
  | "missing";

export interface WorktreeStateEntry {
  path: string;
  branch: string;
  state: WorktreeState;
  eligible: boolean;
  requiresForce: boolean;
  ownerRunId: string;
  reason: string;
}

export interface WorktreeStateInput {
  path: string;
  branch: string;
  ownerRunId: string;
  ownerTerminal: boolean;
  state: string;
  onDisk: boolean;
  dirty: boolean;
}

export function classifyWorktreeState(input: WorktreeStateInput): WorktreeStateEntry {
  const base = { path: input.path, branch: input.branch, ownerRunId: input.ownerRunId };
  if (!input.onDisk) {
    return {
      ...base,
      state: "missing",
      eligible: true,
      requiresForce: false,
      reason: "registered but gone from disk — the row is stale",
    };
  }
  if (!input.ownerTerminal) {
    return {
      ...base,
      state: "held",
      eligible: false,
      requiresForce: false,
      reason: "the owning run is still live or suspended",
    };
  }
  if (input.state === "provision-failed") {
    return {
      ...base,
      state: "provision-failed",
      eligible: false,
      requiresForce: false,
      reason: "provisioning failed — kept for diagnosis",
    };
  }
  if (input.dirty) {
    return {
      ...base,
      state: "abandoned-dirty",
      eligible: false,
      requiresForce: false,
      reason: "the owning run is terminal and the tree has uncommitted work",
    };
  }
  return {
    ...base,
    state: "abandoned",
    eligible: true,
    requiresForce: false,
    reason: "the owning run is terminal and the tree is clean",
  };
}

export async function listWorktreeStates(
  sql: RegistrySql,
  owner: (runId: string) => Promise<OwnerState> = readOwner,
): Promise<WorktreeStateEntry[]> {
  const rows = await listWorktrees(sql);
  const owners = new Map<string, OwnerState>();
  for (const runId of new Set(rows.map((row) => row.ownerRunId))) {
    owners.set(runId, await owner(runId));
  }
  return Promise.all(
    rows.map(async (row) => {
      const onDisk = existsSync(row.path);
      return classifyWorktreeState({
        path: row.path,
        branch: row.branch,
        ownerRunId: row.ownerRunId,
        ownerTerminal: owners.get(row.ownerRunId)?.terminal ?? true,
        state: row.state,
        onDisk,
        dirty: onDisk ? await isWorktreeDirty(row.path) : false,
      });
    }),
  );
}
