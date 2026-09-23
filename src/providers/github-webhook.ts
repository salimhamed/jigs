// The per-repo GitHub webhook leg of `jigs bind`: idempotent create-or-update
// against the repo's hook list, signed with the factory's GITHUB_WEBHOOK_SECRET.
// Hook administration is a permission in its own right — an App needs
// "Repository webhooks: read & write" before any of this works.

import { githubRequest } from "./github-api.ts";

// Reviews, inline review comments, conversation comments, and the check-run
// half of CI. `issue_comment` is here because a factory sharing its operator's
// GitHub identity cannot receive a formal review on its own pull request, so
// the conversation is where feedback arrives. `status` names only a commit;
// ingress resolves that sha to its open pull requests before routing it. Every
// re-bind PATCHes the hook, so a change here lands on the next bind.
export const WEBHOOK_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "check_suite",
  "status",
];

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

const REMOTE_PATTERNS = [
  /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
  /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
  /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
];

export function parseGithubRemote(url: string): GitHubRepoRef | null {
  for (const pattern of REMOTE_PATTERNS) {
    const match = pattern.exec(url.trim());
    const [, owner, repo] = match ?? [];
    if (owner !== undefined && repo !== undefined && !repo.includes("/")) {
      return { owner, repo };
    }
  }
  return null;
}

export interface EnsureRepoWebhookOptions extends GitHubRepoRef {
  ingressUrl: string;
  secret: string;
}

interface RepoHook {
  id: number;
  active: boolean;
  events: string[];
  config: { url?: string; content_type?: string };
}

export function githubWebhookUrl(ingressUrl: string): string {
  return `${ingressUrl.replace(/\/+$/, "")}/ingress/github`;
}

function isJigsHookAtAnotherUrl(hook: RepoHook, desiredUrl: string): boolean {
  try {
    const url = new URL(hook.config.url ?? "");
    return url.pathname === "/ingress/github" && url.host !== new URL(desiredUrl).host;
  } catch {
    return false;
  }
}

const sameEvents = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

export interface EnsureRepoWebhookResult {
  // "verified": the hook's visible settings already matched; "updated": they
  // had drifted. Either way the full config, secret included, was re-sent.
  outcome: "created" | "verified" | "updated";
  otherHosts: string[];
}

const matchesDesired = (hook: RepoHook, hookUrl: string) =>
  hook.active &&
  sameEvents(hook.events, WEBHOOK_EVENTS) &&
  hook.config.url === hookUrl &&
  hook.config.content_type === "json";

export async function ensureRepoWebhook({
  owner,
  repo,
  ingressUrl,
  secret,
}: EnsureRepoWebhookOptions): Promise<EnsureRepoWebhookResult> {
  const hookUrl = githubWebhookUrl(ingressUrl);
  const hooksPath = `/repos/${owner}/${repo}/hooks`;
  const hooks = await githubRequest<RepoHook[]>("GET", `${hooksPath}?per_page=100`);
  const existing = hooks.find((hook) => hook.config.url === hookUrl);
  const otherHosts = [
    ...new Set(
      hooks
        .filter((hook) => isJigsHookAtAnotherUrl(hook, hookUrl))
        .map((hook) => new URL(hook.config.url ?? "").host),
    ),
  ];
  const desired = {
    config: { url: hookUrl, content_type: "json", secret },
    events: WEBHOOK_EVENTS,
    active: true,
  };
  if (existing === undefined) {
    await githubRequest("POST", hooksPath, desired);
    return { outcome: "created", otherHosts };
  }
  // GitHub never returns a hook's secret, so a rotated local one is invisible
  // here: always re-send it rather than trusting the settings that do show.
  await githubRequest("PATCH", `${hooksPath}/${existing.id}`, desired);
  return { outcome: matchesDesired(existing, hookUrl) ? "verified" : "updated", otherHosts };
}

interface HookDelivery {
  delivered_at: string;
  status_code: number;
}

export type RepoWebhookState =
  | { state: "ok" }
  | { state: "missing" }
  | { state: "rejected"; status: 401 | 503; count: number };

// Enough to see past a burst of redeliveries. The list's order is not
// documented, so it is sorted here.
const DELIVERY_SAMPLE = 10;

// A wrong secret cannot be read off the hook, only off GitHub's delivery log.
// The ingress answers a bad signature with 401 and a missing secret with 503;
// `count` is the newest unbroken run of that status. A hook with no
// deliveries yet is "ok".
export async function inspectRepoWebhook({
  owner,
  repo,
  ingressUrl,
}: Omit<EnsureRepoWebhookOptions, "secret">): Promise<RepoWebhookState> {
  const hooksPath = `/repos/${owner}/${repo}/hooks`;
  const hooks = await githubRequest<RepoHook[]>("GET", `${hooksPath}?per_page=100`);
  const hookUrl = githubWebhookUrl(ingressUrl);
  const hook = hooks.find(
    (candidate) =>
      candidate.config.url === hookUrl &&
      candidate.active &&
      sameEvents(candidate.events, WEBHOOK_EVENTS),
  );
  if (hook === undefined) return { state: "missing" };
  const deliveries = await githubRequest<HookDelivery[]>(
    "GET",
    `${hooksPath}/${hook.id}/deliveries?per_page=${DELIVERY_SAMPLE}`,
  );
  const newestFirst = [...deliveries].sort((a, b) => b.delivered_at.localeCompare(a.delivered_at));
  const status = newestFirst[0]?.status_code;
  if (status !== 401 && status !== 503) return { state: "ok" };
  const runEnd = newestFirst.findIndex((delivery) => delivery.status_code !== status);
  return { state: "rejected", status, count: runEnd === -1 ? newestFirst.length : runEnd };
}
