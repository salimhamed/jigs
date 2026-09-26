import { describeSuspension } from "../../run-suspension.ts";
import { TICKET_TOKEN_PREFIX } from "../../workflow/linear/claim.ts";
import type { RunState } from "../../workflow/runtime/resources.ts";
import { listResources, type RegistrySql, toRecord } from "./registry.ts";

/** What the World knows about a run: its status and workflow, or nulls when it has no such run, and its hook tokens. */
export interface WorldRunFacts {
  status: string | null;
  workflowName: string | null;
  tokens: readonly string[];
}

/**
 * Read one run's whole state as plain data: its resources in this factory with their states and
 * reasons, and the hooks it holds. `jigs status`, release and prune all read runs through this,
 * so the same question never gets two answers.
 *
 * @remarks
 * The World is passed in because the offline CLI cannot open it; there it supplies only the
 * status it reads from the database.
 *
 * @example
 * ```ts
 * await readRunState(registrySql(), currentFactory(), runId, worldRunFacts);
 * // {
 * //   runId: "wrun_01K…", status: "completed", workflowName: "workflow//./workflows/ship//ship",
 * //   resources: [{ kind: "worktree", identity: "/…/worktrees/age-12", state: "kept",
 * //                 reason: "uncommitted work kept", … }],
 * //   claim: "linear:ticket:…", waitingOn: []
 * // }
 * ```
 */
export async function readRunState(
  db: RegistrySql,
  factory: string,
  runId: string,
  world: (runId: string) => Promise<WorldRunFacts>,
): Promise<RunState> {
  const [rows, facts] = await Promise.all([listResources(db, { factory, runId }), world(runId)]);
  return {
    runId,
    status: facts.status,
    workflowName: facts.workflowName,
    resources: rows.map(toRecord),
    claim: facts.tokens.find((token) => token.startsWith(TICKET_TOKEN_PREFIX)) ?? null,
    waitingOn: facts.tokens.flatMap((token) => describeSuspension(token) ?? []),
  };
}
