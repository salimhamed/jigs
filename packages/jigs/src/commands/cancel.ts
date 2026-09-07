import { CliError } from "../errors.ts";
import {
  readErrorBody,
  runRefError,
  type ServiceDeps,
  serviceFetch,
} from "./service.ts";

// The escape hatch for a zombie claim owner: cancelling releases every
// resource the run holds, so the next run on the same ticket can start.

export interface CancelDeps extends ServiceDeps {
  confirm?: (question: string) => Promise<boolean>;
  force?: boolean;
}

export interface CancelResult {
  runId: string;
  cancelled: boolean;
  releasedTokens: string[];
  worktrees: string[];
}

export async function cancelRun(
  ref: string,
  deps: CancelDeps,
): Promise<CancelResult | null> {
  const runPath = `/api/runs/${encodeURIComponent(ref)}`;
  const lookup = await serviceFetch(deps.serviceUrl, runPath);
  if (lookup.status === 404 || lookup.status === 409) {
    throw runRefError(ref, await readErrorBody(lookup));
  }
  if (!lookup.ok) {
    throw new CliError(
      `cancel failed: HTTP ${lookup.status} ${await lookup.text()}`,
    );
  }
  const run = (await lookup.json()) as {
    runId: string;
    status: string;
    suspended?: boolean;
  };

  // A suspended run holds no process, so there is nothing to destroy and
  // nothing to ask about. Only work actually in flight earns the prompt.
  if (
    run.status === "running" &&
    run.suspended !== true &&
    deps.force !== true
  ) {
    if (deps.confirm === undefined) {
      throw new CliError(
        "refusing to cancel an in-flight run without confirmation",
        "re-run with --force",
      );
    }
    if (!(await deps.confirm(`cancel in-flight run ${run.runId}?`))) {
      deps.out("left alone");
      return null;
    }
  }

  const res = await serviceFetch(
    deps.serviceUrl,
    `/api/runs/${encodeURIComponent(run.runId)}/cancel`,
    { method: "POST" },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new CliError(body.error ?? `cancel failed: HTTP ${res.status}`);
  }
  const result = (await res.json()) as CancelResult;
  deps.out(`cancelled ${result.runId}`);
  for (const token of result.releasedTokens) deps.out(`released ${token}`);
  // Cancel never cleans up; the sentence replaces what a background pass
  // would otherwise do silently.
  for (const path of result.worktrees ?? []) {
    deps.out(`worktree kept at ${path} — jigs sweep to review`);
  }
  return result;
}
