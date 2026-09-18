// The per-repo GitHub webhook leg of `jigs bind`: one shared secret in the
// jigs data dir, idempotent create/verify/repair against the repo's hook list.
// Hook administration is a permission in its own right — an App needs
// "Repository webhooks: read & write" before any of this works.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { githubWebhookSecretFile, jigsDataDir } from "../config/paths.ts";
import { githubRequest } from "./github-api.ts";

// Reviews, inline review comments, conversation comments, and the check-run
// half of CI. `issue_comment` is here because a factory sharing its operator's
// GitHub identity cannot receive a formal review on its own pull request, so
// the conversation is where feedback arrives. `status` names only a commit;
// ingress resolves that sha to its open pull requests before routing it. The
// drift PATCH picks up a change on re-bind.
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

// One shared secret for all repo webhooks, generated on first need. The
// service reads the same file (or its GITHUB_WEBHOOK_SECRET override).
export function ensureWebhookSecret(dataDir: string = jigsDataDir()): string {
  const file = githubWebhookSecretFile(dataDir);
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing !== "") return existing;
  }
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
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
  outcome: "created" | "verified" | "updated";
  otherHosts: string[];
}

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
  if (
    existing.active &&
    sameEvents(existing.events, WEBHOOK_EVENTS) &&
    existing.config.url === hookUrl &&
    existing.config.content_type === "json"
  ) {
    return { outcome: "verified", otherHosts };
  }
  // Full-config PATCH: GitHub never returns the secret, so re-sending it
  // reconverges a drifted or rotated one along with the events.
  await githubRequest("PATCH", `${hooksPath}/${existing.id}`, desired);
  return { outcome: "updated", otherHosts };
}

export async function verifyRepoWebhook({
  owner,
  repo,
  ingressUrl,
}: Omit<EnsureRepoWebhookOptions, "secret">): Promise<boolean> {
  const hooks = await githubRequest<RepoHook[]>(
    "GET",
    `/repos/${owner}/${repo}/hooks?per_page=100`,
  );
  const hookUrl = githubWebhookUrl(ingressUrl);
  return hooks.some(
    (hook) => hook.config.url === hookUrl && hook.active && sameEvents(hook.events, WEBHOOK_EVENTS),
  );
}
