import { JigsError } from "../../errors.ts";
import { prFromToken } from "../../run-suspension.ts";
import { TICKET_TOKEN_PREFIX } from "../../workflow/linear/claim.ts";
import type { ResourceRecord } from "../../workflow/runtime/resources.ts";
import { displayPath, hint, indent, runHeading } from "../output.ts";
import { runNotFound, type ServiceDeps, serviceFetch } from "./service-client.ts";

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
  retainedTokens: string[];
  worktrees: string[];
}

interface CancelledRun {
  runId: string;
  status: string;
  suspensions: unknown[];
  ticket?: string | null;
  resources?: ResourceRecord[];
}

export async function cancelRun(runId: string, deps: CancelDeps): Promise<CancelResult | null> {
  const runPath = `/api/runs/${encodeURIComponent(runId)}`;
  const lookup = await serviceFetch(deps.serviceUrl, runPath);
  if (lookup.status === 404) throw runNotFound(runId);
  if (!lookup.ok) {
    throw new JigsError(`cancel failed: HTTP ${lookup.status} ${await lookup.text()}`);
  }
  const run = (await lookup.json()) as CancelledRun;

  // A parked run holds no process, so there is nothing to destroy and nothing
  // to ask about. Only work actually in flight earns the prompt.
  if (run.status === "running" && run.suspensions.length === 0 && deps.force !== true) {
    if (deps.confirm === undefined) {
      throw new JigsError(
        "refusing to cancel an in-flight run without confirmation",
        `confirm with --force: \`pnpm exec jigs cancel ${run.runId} --force\``,
      );
    }
    if (!(await deps.confirm(`cancel in-flight run ${run.runId}?`))) {
      deps.out(`did not cancel ${run.runId}`);
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
    throw new JigsError(body.error ?? `cancel failed: HTTP ${res.status}`);
  }
  const result = (await res.json()) as CancelResult;
  const held = (token: string) => heldBy(token, run);
  // Cancel leaves the worktree behind; offline prune proves the service and
  // every child stopped before it considers local resources.
  const worktrees = result.worktrees.map((path) => `kept the worktree at ${displayPath(path)}`);
  const review =
    result.worktrees.length === 0
      ? []
      : hint(
          "to see what can be removed, run:",
          `pnpm exec jigs resources prune --run ${result.runId}`,
        );
  for (const line of [
    runHeading(result.runId, "cancelled"),
    ...indent([
      ...result.releasedTokens.map((token) => `stopped ${held(token)}`),
      ...result.retainedTokens.map((token) => `still ${held(token)}`),
      ...worktrees,
      ...review,
    ]),
  ]) {
    deps.out(line);
  }
  return result;
}

const HOLDING = { claim: "claiming", "pull-request": "watching", other: "waiting for" } as const;

function heldBy(token: string, run: CancelledRun): string {
  const subject = hookSubject(token, run);
  return `${HOLDING[subject.kind]} ${subject.label}`;
}

/**
 * What a hook token is about, as the operator knows it: the run's ticket and pull request by
 * their own names rather than the token that addresses them.
 */
export function hookSubject(
  token: string,
  run: Pick<CancelledRun, "ticket" | "resources"> = {},
): { kind: keyof typeof HOLDING; label: string } {
  if (token.startsWith(TICKET_TOKEN_PREFIX)) {
    const label = run.ticket == null ? "the Linear ticket" : `Linear ticket ${run.ticket}`;
    return { kind: "claim", label };
  }
  const pr = prFromToken(token);
  if (pr === null) return { kind: "other", label: token };
  // The token lowercases the repository; the recorded pull request keeps its real name.
  const recorded = run.resources?.find(
    (resource) => resource.kind === "pull-request" && resource.identity.toLowerCase() === pr.slug,
  );
  return { kind: "pull-request", label: `pull request ${recorded?.identity ?? pr.slug}` };
}
