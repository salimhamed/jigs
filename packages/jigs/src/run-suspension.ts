import type { WakeNote } from "./service/wake.ts";
import { describeHookToken, type HookKind } from "./workflow/hook-tokens.ts";
import type { ApprovalState, PullRequestSnapshot } from "./workflow/pull-requests/snapshot.ts";

/**
 * One hook a run is currently parked on. Everything below `question` is read
 * from a provider, so it is present only on the single-run route: the listing
 * behind `jigs status` and `jigs watch` describes a suspension from its token
 * alone.
 */
export interface RunSuspension {
  token: string;
  kind: Exclude<HookKind, "ticket-claim"> | "external";
  /** What the run is waiting for, in the words an operator acts on. */
  reason: string;
  /** Where to go and act: the pull request, or the ticket comment that asked. */
  url?: string;
  /** The question jigs asked, once the service has read it back from Linear. */
  question?: string;
  /** The commit the pull request is on, shortened. */
  headSha?: string;
  ci?: PullRequestSnapshot["ci"];
  approval?: ApprovalState;
  draft?: boolean;
  /** GitHub's own `mergeable_state`, as the readiness check reads it. */
  mergeState?: string;
  /** Why the readiness check refuses a merge, or that nothing is stopping it. */
  blocker?: string;
  /** What last resumed this wait, if the service has woken it since it started. */
  lastWake?: WakeNote;
}

/**
 * What a run holding this hook is waiting for, or null when the hook is no
 * park at all. The token is the whole answer: it names what the run is waiting
 * on, so nothing has to be written down beside it. The ticket claim and a
 * Linear agent session's hook are held for the run's whole life and so say
 * nothing about waiting; every other hook is
 * something the run waits on, including a token jigs has never seen. `jigs status`,
 * `jigs watch` and `jigs cancel` all read this one function, or a run one calls
 * suspended is one another refuses to confirm.
 *
 * `ticket` is the identifier the run was launched with, so a halt names the
 * ticket an operator knows rather than the issue UUID inside the token.
 */
export function describeSuspension(token: string, ticket?: string | null): RunSuspension | null {
  const { kind, reason, url } = describeHookToken(token, ticket);
  if (kind === "ticket-claim" || kind === "linear-session") return null;
  return { token, kind, reason, ...(url === undefined ? {} : { url }) };
}
