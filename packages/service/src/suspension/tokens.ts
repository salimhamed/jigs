// Hook tokens name external resources, never runs: token ownership is the
// exclusivity lock (ADR 0009). The ingress (AGE-314) reconstructs these from
// webhook payloads, so build/parse must stay in exact sync.

// A type alias (implicit index signature) so a PrRef can ride along as
// serializable hook metadata.
export type PrRef = {
  owner: string;
  repo: string;
  number: number;
};

export function prToken(pr: PrRef): string {
  return `github:pr:${pr.owner}/${pr.repo}#${pr.number}`;
}

// Linear Comment webhook payloads carry issueId as a UUID, so the token does too.
export function ticketToken(issueId: string): string {
  return `linear:ticket:${issueId}`;
}

const PR_TOKEN_PATTERN = /^github:pr:([^/#]+)\/([^/#]+)#(\d+)$/;

export function parsePrToken(token: string): PrRef | null {
  const match = token.match(PR_TOKEN_PATTERN);
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return null;
  }
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

const TICKET_TOKEN_PATTERN =
  /^linear:ticket:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function parseTicketToken(token: string): { issueId: string } | null {
  const match = token.match(TICKET_TOKEN_PATTERN);
  if (match === null || match[1] === undefined) return null;
  return { issueId: match[1] };
}
