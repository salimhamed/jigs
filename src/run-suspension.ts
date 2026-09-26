import type { WakeNote } from "./service/wake-note.ts";
import { TICKET_TOKEN_PREFIX } from "./workflow/linear/claim.ts";
import { NEEDS_HUMAN_TOKEN_PREFIX } from "./workflow/linear/halt-for-human.ts";
import {
  PULL_REQUEST_TOKEN_PREFIX,
  type PullRequestRef,
} from "./workflow/pull-requests/pull-request.ts";
import type { ApprovalState, PullRequestSnapshot } from "./workflow/pull-requests/snapshot.ts";

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
  ci?: PullRequestSnapshot["ci"];
  approval?: ApprovalState;
  draft?: boolean;
  /** GitHub's own `mergeable_state`, as the readiness check reads it. */
  mergeState?: string;
  /** Why the readiness check refuses a merge, or that nothing is stopping it. */
  blocker?: string;
  /** What last resumed this run's pull request wait, if the service has woken it since it started. */
  lastWake?: WakeNote;
}

/**
 * What a run holding this hook is waiting for, or null when the hook is no
 * park at all. The token is the whole answer: it names what the run is waiting
 * on, so nothing has to be written down beside it. The ticket claim is held for
 * the run's whole life and so says nothing about waiting; every other hook is
 * something the run waits on, including a token jigs has never seen. `jigs status`,
 * `jigs watch` and `jigs cancel` all read this one function, or a run one calls
 * suspended is one another refuses to confirm.
 *
 * `ticket` is the identifier the run was launched with, so a halt names the
 * ticket an operator knows rather than the issue UUID inside the token.
 */
export function describeSuspension(token: string, ticket?: string | null): RunSuspension | null {
  if (token.startsWith(TICKET_TOKEN_PREFIX)) return null;
  const pr = prFromToken(token);
  if (pr !== null) {
    return {
      token,
      kind: "pull-request",
      reason: `waiting for pull request activity on ${pr.slug}`,
      url: pr.url,
    };
  }
  // The prefix alone decides the kind: a marker jigs minted is a halt even
  // when the rest of it is unreadable, and calling that external would point
  // an operator at the wrong thing to do about it.
  if (token.startsWith(NEEDS_HUMAN_TOKEN_PREFIX)) {
    const where = ticket ?? needsHumanParts(token)?.issueId;
    return {
      token,
      kind: "needs-human",
      reason:
        where === undefined
          ? `waiting for a human reply, on a ticket this halt marker does not name (${token})`
          : `waiting for a human reply on ${where}`,
    };
  }
  return { token, kind: "external", reason: `waiting for an external event (${token})` };
}

/** `github:pr:owner/repo#N` as the two things an operator needs from it. A
 *  slug this shape does not fit names no page to link to. */
export function prFromToken(
  token: string,
): { slug: string; url?: string; pr?: PullRequestRef } | null {
  if (!token.startsWith(PULL_REQUEST_TOKEN_PREFIX)) return null;
  const slug = token.slice(PULL_REQUEST_TOKEN_PREFIX.length);
  const parsed = /^([^/]+)\/([^#]+)#(\d+)$/.exec(slug);
  if (parsed === null) return { slug };
  const [, owner, repo, number] = parsed;
  if (owner === undefined || repo === undefined || number === undefined) return { slug };
  return {
    slug,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    pr: { owner, repo, number: Number(number) },
  };
}

/** `jigs:needs-human:<issue>:<comment>` — the halt marker, taken apart. */
export function needsHumanParts(token: string): { issueId: string; commentId: string } | null {
  if (!token.startsWith(NEEDS_HUMAN_TOKEN_PREFIX)) return null;
  const [issueId, commentId] = token.slice(NEEDS_HUMAN_TOKEN_PREFIX.length).split(":");
  return issueId === undefined || commentId === undefined ? null : { issueId, commentId };
}
