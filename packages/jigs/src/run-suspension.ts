import type { WakeNote } from "./service/wake.ts";
import { describeHookToken, type HookKind, isOwnershipKind } from "./workflow/hook-tokens.ts";

/** One hook a run is currently parked on. */
export interface RunSuspension {
  token: string;
  kind: Exclude<HookKind, "ticket-claim" | "linear-session"> | "external";
  /** What the run is waiting for, in the words an operator acts on. */
  reason: string;
  /** The pull request to go and act on. */
  url?: string;
  /** What last resumed this wait, on the single-run route, if the service has woken it since it started. */
  lastWake?: WakeNote;
}

/**
 * What a run holding this hook is waiting for, or null when the hook is no
 * park at all. The token is the whole answer: it names what the run is waiting
 * on, so nothing has to be written down beside it. The ticket claim and a
 * Linear agent session's ownership hook are held for the run's whole life and
 * so say nothing about waiting; every other hook is
 * something the run waits on, including a token jigs has never seen. `jigs status`,
 * `jigs watch` and `jigs cancel` all read this one function, or a run one calls
 * suspended is one another refuses to confirm.
 */
export function describeSuspension(token: string): RunSuspension | null {
  const { kind, reason, url } = describeHookToken(token);
  if (isOwnershipKind(kind)) return null;
  return { token, kind, reason, ...(url === undefined ? {} : { url }) };
}
