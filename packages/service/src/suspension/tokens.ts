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
