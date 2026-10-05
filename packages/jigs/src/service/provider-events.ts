// Route a verified provider event to the runs it concerns: wake the hooks it
// names, or hand it to the event triggers. Callers have already checked where
// the event came from; nothing here sees a request, a raw body or a signature.

import type { FactoryContext } from "../config/factory-context.ts";
import { findOpenPullRequestsByHeadSha } from "../providers/github.ts";
import { tokenFromLinearPayload } from "../workflow/linear/claim.ts";
import type { Provider } from "../workflow/providers.ts";
import { tokenFromGitHubPayload } from "../workflow/pull-requests/pull-request.ts";
import type { pushEvent } from "./event-triggers/runner.ts";
import { wakeSlackThread } from "./slack-thread-wake.ts";
import { wake } from "./wake.ts";

/** One event from a provider: GitHub's `X-GitHub-Event` value or the payload's own type, and its JSON body. */
export interface ProviderEvent {
  provider: Provider;
  name: string;
  payload: unknown;
}

export interface RouteDeps {
  context: FactoryContext;
  push: typeof pushEvent;
}

/**
 * What routing did. `dropped` found nothing waiting; `failed` could not tell,
 * so the event is worth routing again.
 */
export type RouteResult =
  | { outcome: "ignored" | "woken" | "dropped" | "failed" }
  | { outcome: "triggered"; triggers: string[] };

/** Wake the runs a provider event concerns, or start the ones its triggers take. */
export function routeProviderEvent(event: ProviderEvent, deps: RouteDeps): Promise<RouteResult> {
  switch (event.provider) {
    case "github":
      return routeGithub(event, deps);
    case "linear":
      return event.name === "AgentSessionEvent" ? routePush(event, deps) : routeLinear(event);
    case "pagerduty":
      return routePush(event, deps);
    case "slack":
      return routeSlack(event, deps);
  }
}

async function routeGithub({ name, payload }: ProviderEvent, deps: RouteDeps) {
  const event = sanitizeForLog(name);
  if (event === "status") {
    const status = githubStatus(payload);
    if (status === null) {
      console.log(`[events] github ignored reason=unrecognized-event event=${event}`);
      return { outcome: "ignored" } as const;
    }
    if (status.state === "pending") {
      console.log(`[events] github ignored reason=pending-status event=${event}`);
      return { outcome: "ignored" } as const;
    }
    let prs: Awaited<ReturnType<typeof findOpenPullRequestsByHeadSha>>;
    try {
      prs = await findOpenPullRequestsByHeadSha(status.repository, status.sha, deps.context);
    } catch {
      console.log(`[events] github dropped reason=status-lookup-failed event=${event}`);
      return { outcome: "failed" } as const;
    }
    if (prs.length === 0) {
      console.log(`[events] github dropped reason=no-open-pull-request event=${event}`);
      return { outcome: "dropped" } as const;
    }
    const tokens = prs
      .map((pr) =>
        tokenFromGitHubPayload({
          pull_request: { number: pr.number },
          repository: { name: pr.repo, owner: { login: pr.owner } },
        }),
      )
      .filter((token): token is string => token !== null);
    return wakeAndLog("github", tokens, event);
  }
  const token = tokenFromGitHubPayload(payload);
  if (token === null) {
    console.log(`[events] github ignored reason=unrecognized-event event=${event}`);
    return { outcome: "ignored" } as const;
  }
  return wakeAndLog("github", [token], event);
}

async function routeLinear({ name, payload }: ProviderEvent) {
  if (payload === null) {
    console.log("[events] linear ignored reason=unrecognized-shape");
    return { outcome: "ignored" } as const;
  }
  const event = name === "" ? null : sanitizeForLog(name);
  const token = tokenFromLinearPayload(payload);
  if (token === null) {
    console.log(
      `[events] linear ignored reason=unrecognized-event${event === null ? "" : ` event=${event}`}`,
    );
    return { outcome: "ignored" } as const;
  }
  return wakeAndLog("linear", [token], event);
}

// PagerDuty events and Linear agent sessions start runs rather than wake them.
// The push returns once the occurrence is recorded, never waiting on the start.
async function routePush({ provider, name, payload }: ProviderEvent, deps: RouteDeps) {
  const event = `event=${sanitizeForLog(name)}`;
  let triggers: string[];
  try {
    triggers = await deps.push(provider, payload);
  } catch (error) {
    console.log(`[events] ${provider} dropped reason=push-failed ${event}: ${String(error)}`);
    return { outcome: "failed" } as const;
  }
  if (triggers.length === 0) {
    console.log(`[events] ${provider} ignored reason=no-new-occurrence ${event}`);
    return { outcome: "ignored" } as const;
  }
  console.log(`[events] ${provider} accepted triggers=${triggers.join(",")} ${event}`);
  return { outcome: "triggered", triggers } as const;
}

// Slack sends the Events API body; its `event` is the message. A message can
// both start runs and answer a thread a run waits on, and a wake that landed
// stands even when a trigger could not read the event.
async function routeSlack({ payload }: ProviderEvent, deps: RouteDeps): Promise<RouteResult> {
  const message = (payload as { event?: unknown } | null)?.event;
  const [triggers, woke] = await Promise.all([
    deps.push("slack", payload).catch((error: unknown) => {
      const { channel, ts } = (message ?? {}) as { channel?: unknown; ts?: unknown };
      console.log(
        `[slack] could not start runs for ${String(channel)}:${String(ts)}: ${String(error)}`,
      );
      return null;
    }),
    wakeSlackThread(message),
  ]);
  if (triggers !== null && triggers.length > 0) return { outcome: "triggered", triggers };
  if (woke) return { outcome: "woken" };
  return { outcome: triggers === null ? "failed" : "ignored" };
}

function sanitizeForLog(value: string): string {
  return value.replace(/[\r\n\t]/g, " ");
}

function githubStatus(payload: unknown): {
  sha: string;
  state: string;
  repository: { owner: string; repo: string };
} | null {
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as {
    sha?: unknown;
    state?: unknown;
    repository?: { name?: unknown; owner?: { login?: unknown } };
  };
  const { sha, state } = candidate;
  const owner = candidate.repository?.owner?.login;
  const repo = candidate.repository?.name;
  return typeof sha === "string" &&
    typeof state === "string" &&
    typeof owner === "string" &&
    typeof repo === "string"
    ? { sha, state, repository: { owner, repo } }
    : null;
}

// A wake carries no payload: the suspension primitives re-check provider
// state on every wake, so nothing downstream reads one.
async function wakeAndLog(
  provider: Provider,
  tokens: string[],
  event: string | null,
): Promise<RouteResult> {
  const outcomes = await Promise.all(
    tokens.map(async (token) => {
      const correlation = `token=${sanitizeForLog(token)}${event === null ? "" : ` event=${event}`}`;
      const { outcome } = await wake(token, event === null ? provider : `${provider} ${event}`);
      if (outcome === "woken") console.log(`[events] ${provider} accepted ${correlation}`);
      else {
        const reason = outcome === "gone" ? "no-matching-hook" : "delivery-failed";
        console.log(`[events] ${provider} dropped reason=${reason} ${correlation}`);
      }
      return outcome;
    }),
  );
  if (outcomes.includes("woken")) return { outcome: "woken" };
  return { outcome: outcomes.includes("failed") ? "failed" : "dropped" };
}
