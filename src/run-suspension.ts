import type { WakeNote } from "./service/wake-note.ts";
import type { ApprovalState } from "./workflow/pull-requests/merge-ready.ts";

/**
 * One hook a run is currently parked on. Everything below `question` is read
 * from a provider, so it is present only on the single-run route: the listing
 * behind `jigs status` and `jigs watch` describes a suspension from its token
 * alone.
 */
export interface RunSuspension {
  token: string;
  kind: "pull-request" | "needs-human" | "external";
  /** What the run is waiting for, in the words an operator acts on. */
  reason: string;
  /** Where to go and act: the pull request, or the ticket comment that asked. */
  url?: string;
  /** The question jigs asked, once the service has read it back from Linear. */
  question?: string;
  /** The commit the pull request is on, shortened. */
  headSha?: string;
  ci?: "green" | "red" | "pending";
  approval?: ApprovalState;
  draft?: boolean;
  /** GitHub's own `mergeable_state`, as the merge gate reads it. */
  mergeState?: string;
  /** Why the merge gate will not merge this, or that nothing is stopping it. */
  blocker?: string;
  /** What last resumed this run's gate, if the service has woken it since it started. */
  lastWake?: WakeNote;
}
