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
export const TICKET_TOKEN_PREFIX = "linear:ticket:";

export function ticketToken(issueId: string): string {
  return `${TICKET_TOKEN_PREFIX}${issueId}`;
}

type GithubPayload = {
  pull_request?: { number?: unknown };
  // issue_comment fires for issues too; only a PR carries issue.pull_request.
  issue?: { number?: unknown; pull_request?: unknown };
  check_suite?: { pull_requests?: Array<{ number?: unknown }> };
  check_run?: { pull_requests?: Array<{ number?: unknown }> };
  repository?: { name?: unknown; owner?: { login?: unknown } };
};

function prNumber(payload: GithubPayload): number | null {
  const candidates = [
    payload.pull_request?.number,
    payload.issue?.pull_request === undefined
      ? undefined
      : payload.issue?.number,
    payload.check_suite?.pull_requests?.[0]?.number,
    payload.check_run?.pull_requests?.[0]?.number,
  ];
  const number = candidates.find((value) => typeof value === "number");
  return number ?? null;
}

// Any GitHub event that names a pull request and a repository is routable:
// pull_request and pull_request_review carry it directly, issue_comment
// carries it only on a PR, and the check events carry it in a list. Everything
// else (ping included) is not.
export function tokenFromGithubPayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { repository } = payload as GithubPayload;
  const repo = repository?.name;
  const owner = repository?.owner?.login;
  const number = prNumber(payload as GithubPayload);
  if (
    number === null ||
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
