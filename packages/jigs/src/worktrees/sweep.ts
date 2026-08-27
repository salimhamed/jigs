// The sweep classifier: pure, zero IO, so every rule in ADR 0007's
// reconciliation is a table test. The caller gathers the facts (registry
// rows, run states, disk) and acts on the verdict.

export type SweepState =
  | "held"
  | "kept"
  | "abandoned"
  | "abandoned-dirty"
  | "provision-failed"
  | "unregistered"
  | "missing";

export interface SweepInput {
  path: string;
  branch: string;
  ownerRunId: string | null;
  // null when there is no owning run to ask about (an unregistered directory).
  ownerTerminal: boolean | null;
  keep: boolean;
  state: string;
  onDisk: boolean;
  dirty: boolean;
  registered: boolean;
}

export interface SweepEntry {
  path: string;
  branch: string;
  state: SweepState;
  eligible: boolean;
  requiresForce: boolean;
  ownerRunId?: string;
  reason: string;
}

export function classifySweep(input: SweepInput): SweepEntry {
  const owner =
    input.ownerRunId === null ? {} : { ownerRunId: input.ownerRunId };
  const base = { path: input.path, branch: input.branch, ...owner };

  if (input.registered && !input.onDisk) {
    return {
      ...base,
      state: "missing",
      eligible: true,
      requiresForce: false,
      reason: "registered but gone from disk — the row is stale",
    };
  }
  if (!input.registered) {
    return {
      ...base,
      state: "unregistered",
      eligible: true,
      requiresForce: input.dirty,
      reason: input.dirty
        ? "on disk with no registry row, and dirty"
        : "on disk with no registry row",
    };
  }
  if (input.keep) {
    return {
      ...base,
      state: "kept",
      eligible: false,
      requiresForce: false,
      reason: "keep: true was requested",
    };
  }
  if (input.state === "provision-failed") {
    // The half-provisioned tree is the diagnosis evidence ADR 0007 preserves;
    // its owning run failed immediately, so without this the automatic pass
    // would delete the evidence within a minute.
    return {
      ...base,
      state: "provision-failed",
      eligible: true,
      requiresForce: true,
      reason: "provisioning failed — kept for diagnosis",
    };
  }
  // The SDK reads a parked run as `running`, so non-terminal covers live and
  // suspended owners alike: a suspended run keeps its worktree.
  if (input.ownerTerminal === false) {
    return {
      ...base,
      state: "held",
      eligible: false,
      requiresForce: false,
      reason: "the owning run is still live or suspended",
    };
  }
  if (input.dirty) {
    return {
      ...base,
      state: "abandoned-dirty",
      eligible: true,
      requiresForce: true,
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
