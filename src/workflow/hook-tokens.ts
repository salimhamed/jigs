// Every kind of hook token jigs mints, and the only place that takes one apart.
// Each kind's own module builds its tokens from the prefix here.

import type { PullRequestRef } from "./pull-requests/pull-request.ts";

/** Prefix for the durable hook that gives one run exclusive ownership of a ticket. */
export const TICKET_TOKEN_PREFIX = "linear:ticket:";
// The halt's marker hook. It names no external resource and nothing resumes
// it: the reply that ends the halt lands on the ticket claim.
/** Prefix for marker hooks that tell operators which ticket comment needs an answer. */
export const NEEDS_HUMAN_TOKEN_PREFIX = "jigs:needs-human:";
/** The durable hook-token prefix for pull request activity. */
export const PULL_REQUEST_TOKEN_PREFIX = "github:pr:";
/** Prefix for the hook a run parks on while it waits for a reply in a Slack thread. */
export const SLACK_THREAD_TOKEN_PREFIX = "slack:thread:";

/**
 * A hook token jigs minted, taken apart. The prefix alone decides the kind, so
 * a token whose rest is unreadable keeps its kind and loses only its parts.
 */
export type HookToken =
  | { kind: "ticket-claim"; provider: "linear"; issueId: string }
  | {
      kind: "needs-human";
      provider: "linear";
      halt: { issueId: string; commentId: string } | null;
    }
  | { kind: "pull-request"; provider: "github"; slug: string; pr: PullRequestRef | null }
  | {
      kind: "slack-thread";
      provider: "slack";
      thread: { channel: string; threadTs: string } | null;
    };

export type HookKind = HookToken["kind"];

/** What a hook is about, in an operator's words. `external` is a token jigs did not mint. */
export interface HookDescription {
  kind: HookKind | "external";
  /** The thing the hook names, as a noun phrase. */
  label: string;
  /** What a run holding it is waiting for. */
  reason: string;
  url?: string;
}

const pair = (rest: string): [string, string] | null => {
  const at = rest.indexOf(":");
  if (at <= 0 || at === rest.length - 1) return null;
  return [rest.slice(0, at), rest.slice(at + 1)];
};

const HOOK_KINDS: { [K in HookKind]: { prefix: string; parse: (rest: string) => HookToken } } = {
  "ticket-claim": {
    prefix: TICKET_TOKEN_PREFIX,
    parse: (issueId) => ({ kind: "ticket-claim", provider: "linear", issueId }),
  },
  "needs-human": {
    prefix: NEEDS_HUMAN_TOKEN_PREFIX,
    parse: (rest) => {
      const parts = pair(rest);
      return {
        kind: "needs-human",
        provider: "linear",
        halt: parts === null ? null : { issueId: parts[0], commentId: parts[1] },
      };
    },
  },
  "pull-request": {
    prefix: PULL_REQUEST_TOKEN_PREFIX,
    parse: (slug) => {
      const [, owner, repo, number] = /^([^/]+)\/([^#]+)#(\d+)$/.exec(slug) ?? [];
      const pr =
        owner === undefined || repo === undefined || number === undefined
          ? null
          : { owner, repo, number: Number(number) };
      return { kind: "pull-request", provider: "github", slug, pr };
    },
  },
  "slack-thread": {
    prefix: SLACK_THREAD_TOKEN_PREFIX,
    parse: (rest) => {
      const parts = pair(rest);
      return {
        kind: "slack-thread",
        provider: "slack",
        thread: parts === null ? null : { channel: parts[0], threadTs: parts[1] },
      };
    },
  },
};

/** Take a hook token apart, or null when jigs did not mint it. */
export function parseHookToken(token: string): HookToken | null {
  for (const { prefix, parse } of Object.values(HOOK_KINDS)) {
    if (token.startsWith(prefix)) return parse(token.slice(prefix.length));
  }
  return null;
}

/**
 * What a hook token names and what a run holding it waits for. `ticket` is the
 * identifier the run was launched with, so a claim or a halt names the ticket
 * an operator knows rather than the issue UUID inside the token.
 */
export function describeHookToken(token: string, ticket?: string | null): HookDescription {
  const parsed = parseHookToken(token);
  switch (parsed?.kind) {
    case "ticket-claim": {
      const label = ticket == null ? `Linear issue ${parsed.issueId}` : `Linear ticket ${ticket}`;
      return { kind: parsed.kind, label, reason: `holding the claim on ${label}` };
    }
    case "needs-human": {
      const where = ticket ?? parsed.halt?.issueId;
      return {
        kind: parsed.kind,
        label: where === undefined ? token : `the question on ${where}`,
        reason:
          where === undefined
            ? `waiting for a human reply, on a ticket this halt marker does not name (${token})`
            : `waiting for a human reply on ${where}`,
      };
    }
    case "pull-request": {
      const { owner, repo, number } = parsed.pr ?? {};
      return {
        kind: parsed.kind,
        label: `pull request ${parsed.slug}`,
        reason: `waiting for pull request activity on ${parsed.slug}`,
        ...(parsed.pr === null
          ? {}
          : { url: `https://github.com/${owner}/${repo}/pull/${number}` }),
      };
    }
    case "slack-thread": {
      const label =
        parsed.thread === null
          ? `a Slack thread this token does not name (${token})`
          : `the Slack thread ${parsed.thread.threadTs} in ${parsed.thread.channel}`;
      return { kind: parsed.kind, label, reason: `waiting for a reply in ${label}` };
    }
    case undefined:
      return { kind: "external", label: token, reason: `waiting for an external event (${token})` };
  }
}
