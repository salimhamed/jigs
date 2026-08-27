// Hook tokens name external resources, never runs: token ownership is the
// exclusivity lock (ADR 0009). The ingress reconstructs these from webhook
// payloads via tokenFromGithubPayload / tokenFromLinearPayload, so build and
// parse must stay in exact sync — which is why both delegate to prToken /
// ticketToken in this file.

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

// Any GitHub event carrying a pull_request + repository (pull_request,
// pull_request_review, …) is routable; everything else (ping included) is not.
export function tokenFromGithubPayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { pull_request, repository } = payload as {
    pull_request?: { number?: unknown };
    repository?: { name?: unknown; owner?: { login?: unknown } };
  };
  const number = pull_request?.number;
  const repo = repository?.name;
  const owner = repository?.owner?.login;
  if (
    typeof number !== "number" ||
    typeof repo !== "string" ||
    typeof owner !== "string"
  ) {
    return null;
  }
  return prToken({ owner, repo, number });
}

export function tokenFromLinearPayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { type, data } = payload as {
    type?: unknown;
    data?: { issueId?: unknown };
  };
  if (type !== "Comment") return null;
  const issueId = data?.issueId;
  if (typeof issueId !== "string" || issueId === "") return null;
  return ticketToken(issueId);
}
