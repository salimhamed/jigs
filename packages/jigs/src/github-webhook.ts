// The per-repo GitHub webhook leg of `jigs bind` (ADR 0009): one shared
// secret in the jigs data dir, idempotent create/verify/repair against the
// repo's hook list. GITHUB_API_URL override is a test seam.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CliError } from "./errors.ts";

// Complete for the review loop: reviews, inline review comments, PR
// conversation comments, and CI. The drift PATCH picks up a change on re-bind.
export const WEBHOOK_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "check_suite",
];

export interface GithubRepoRef {
  owner: string;
  repo: string;
}

const REMOTE_PATTERNS = [
  /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
  /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
  /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
];

export function parseGithubRemote(url: string): GithubRepoRef | null {
  for (const pattern of REMOTE_PATTERNS) {
    const match = pattern.exec(url.trim());
    const [, owner, repo] = match ?? [];
    if (owner !== undefined && repo !== undefined && !repo.includes("/")) {
      return { owner, repo };
    }
  }
  return null;
}

function defaultJigsDataDir(): string {
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"),
    "jigs",
  );
}

// One shared secret for all repo webhooks, generated on first need. The
// service reads the same file (or its GITHUB_WEBHOOK_SECRET override).
export function ensureWebhookSecret(
  dataDir: string = defaultJigsDataDir(),
): string {
  const file = path.join(dataDir, "github-webhook-secret");
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing !== "") return existing;
  }
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

export interface EnsureRepoWebhookOptions extends GithubRepoRef {
  ingressUrl: string;
  secret: string;
}

interface RepoHook {
  id: number;
  active: boolean;
  events: string[];
  config: { url?: string; content_type?: string };
}

async function githubRequest<T>(
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token === "") {
    throw new CliError("GITHUB_TOKEN is not set");
  }
  const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const res = await fetch(`${base}${apiPath}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new CliError(
      `GitHub API ${res.status} on ${apiPath}: ${await res.text()}`,
    );
  }
  return (await res.json()) as T;
}

const sameEvents = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

export async function ensureRepoWebhook({
  owner,
  repo,
  ingressUrl,
  secret,
}: EnsureRepoWebhookOptions): Promise<"created" | "verified" | "updated"> {
  const hookUrl = `${ingressUrl.replace(/\/+$/, "")}/ingress/github`;
  const hooksPath = `/repos/${owner}/${repo}/hooks`;
  const hooks = await githubRequest<RepoHook[]>(
    "GET",
    `${hooksPath}?per_page=100`,
  );
  // Match by ingress pathname, not full URL: a changed ingress_url (new
  // tunnel hostname) is drift on the existing hook, not a second hook.
  const existing = hooks.find((hook) => {
    try {
      return new URL(hook.config.url ?? "").pathname === "/ingress/github";
    } catch {
      return false;
    }
  });
  const desired = {
    config: { url: hookUrl, content_type: "json", secret },
    events: WEBHOOK_EVENTS,
    active: true,
  };
  if (existing === undefined) {
    await githubRequest("POST", hooksPath, desired);
    return "created";
  }
  if (
    existing.active &&
    sameEvents(existing.events, WEBHOOK_EVENTS) &&
    existing.config.url === hookUrl &&
    existing.config.content_type === "json"
  ) {
    return "verified";
  }
  // Full-config PATCH: GitHub never returns the secret, so re-sending it
  // reconverges a drifted or rotated one along with the events.
  await githubRequest("PATCH", `${hooksPath}/${existing.id}`, desired);
  return "updated";
}
