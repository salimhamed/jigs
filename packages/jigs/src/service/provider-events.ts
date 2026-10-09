// Route a verified provider event to everything in the factory that may want
// it: the event triggers, the runs its hook tokens wake, and the run holding a
// Linear agent session it prompts. Each passes over what is not its own.
// Callers have already checked where the event came from; nothing here sees a
// request, a raw body or a signature.

import type { ProviderEvent } from "@jigs-ai/hub-protocol";
import type { FactoryContext } from "../config/factory-context.ts";
import { findOpenPullRequestsByHeadSha } from "../providers/github.ts";
import {
  pullRequestToken,
  tokenFromGitHubPayload,
} from "../workflow/pull-requests/pull-request.ts";
import { slackThreadTokenFromEvent } from "../workflow/slack/thread-token.ts";
import type { pushEvent } from "./event-triggers/runner.ts";
import { routeSessionPrompt } from "./linear-session-prompts.ts";
import { wake } from "./wake.ts";
import { worthRetrying } from "./worth-retrying.ts";

/** What routing reads of an event the hub received. */
export type RoutedEvent = Pick<ProviderEvent, "provider" | "installationName" | "name" | "payload">;

type NamedEvent = RoutedEvent & { installationName: string };

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

/**
 * Hand a provider event to the triggers, the hooks it wakes and the agent
 * session it prompts, and report what came of it. An event from an
 * installation with no name on the hub concerns none of them.
 */
export async function routeProviderEvent(
  event: RoutedEvent,
  deps: RouteDeps,
): Promise<RouteResult> {
  const { provider } = event;
  const ref = describe(event);
  if (!isNamed(event)) {
    console.log(`[events] ${provider} ignored reason=no-installation-name ${ref}`);
    return { outcome: "ignored" };
  }
  let refused = false;
  const settle = async (consumer: string, route: () => Promise<RouteResult>) => {
    try {
      return await route();
    } catch (error) {
      if (worthRetrying(error)) {
        console.log(
          `[events] ${provider} dropped reason=${consumer}-failed ${ref}: ${String(error)}`,
        );
        return { outcome: "failed" } as const;
      }
      refused = true;
      console.error(
        `[events] ${provider} ignored reason=${consumer}-refused ${ref}: ${String(error)}`,
      );
      return { outcome: "ignored" } as const;
    }
  };
  const result = combine(
    await Promise.all([
      settle("push", () => trigger(event, ref, deps)),
      settle("wake", () => wakeHooks(event, ref, deps)),
      settle("prompt", async () => ({ outcome: await routeSessionPrompt(event) })),
    ]),
  );
  if (result.outcome === "ignored" && !refused && !quiet(provider))
    console.log(`[events] ${provider} ignored ${ref}`);
  return result;
}

// Most Slack messages start nothing and reply in threads no run waits on, so
// logging each would flood a busy workspace.
const quiet = (provider: string) => provider === "slack";

// The event's name and, where the payload carries them, the ids that find it again.
function describe({ provider, name, payload }: RoutedEvent): string {
  const ids: Record<string, unknown> =
    provider === "slack"
      ? { channel: at(payload, "event", "channel"), ts: at(payload, "event", "ts") }
      : provider === "linear"
        ? {
            session: at(payload, "agentSession", "id"),
            activity: at(payload, "agentActivity", "id"),
          }
        : provider === "pagerduty"
          ? { incident: at(payload, "event", "data", "id") }
          : { repo: at(payload, "repository", "full_name"), sha: at(payload, "sha") };
  const found = Object.entries(ids).filter(([, id]) => typeof id === "string");
  return [`event=${name}`, ...found.map(([key, id]) => `${key}=${id}`)]
    .map(sanitizeForLog)
    .join(" ");
}

const at = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (found, key) =>
      typeof found === "object" && found !== null
        ? (found as Record<string, unknown>)[key]
        : undefined,
    value,
  );

const isNamed = (event: RoutedEvent): event is NamedEvent => event.installationName !== null;

// Any failure routes the event again: a trigger records an occurrence once
// however often it arrives, and a wake only makes a run recheck.
function combine(results: RouteResult[]): RouteResult {
  const has = (outcome: RouteResult["outcome"]) => results.some((r) => r.outcome === outcome);
  const triggers = results.flatMap((r) => (r.outcome === "triggered" ? r.triggers : []));
  if (has("failed")) return { outcome: "failed" };
  if (triggers.length > 0) return { outcome: "triggered", triggers };
  if (has("woken")) return { outcome: "woken" };
  return { outcome: has("dropped") ? "dropped" : "ignored" };
}

// The push returns once the occurrence is recorded, never waiting on the start.
async function trigger(
  { provider, installationName, payload }: NamedEvent,
  ref: string,
  deps: RouteDeps,
): Promise<RouteResult> {
  const triggers = await deps.push(provider, { installationName, payload });
  if (triggers.length === 0) return { outcome: "ignored" };
  console.log(`[events] ${provider} accepted triggers=${triggers.join(",")} ${ref}`);
  return { outcome: "triggered", triggers };
}

// A wake carries no payload: the suspension primitives re-check provider
// state on every wake, so nothing downstream reads one.
async function wakeHooks(event: NamedEvent, ref: string, deps: RouteDeps): Promise<RouteResult> {
  const tokens = await hookTokens(event, deps.context);
  if (tokens === null) return { outcome: "ignored" };
  if (tokens.length === 0) {
    console.log(`[events] ${event.provider} dropped reason=no-open-pull-request ${ref}`);
    return { outcome: "dropped" };
  }
  const outcomes = await Promise.all(
    tokens.map(async (token) => {
      const correlation = `token=${sanitizeForLog(token)} ${ref}`;
      const { outcome } = await wake(token, `${event.provider} ${sanitizeForLog(event.name)}`);
      if (outcome === "woken") console.log(`[events] ${event.provider} accepted ${correlation}`);
      else if (outcome === "gone" && quiet(event.provider)) return outcome;
      else {
        const reason = outcome === "gone" ? "no-matching-hook" : "delivery-failed";
        console.log(`[events] ${event.provider} dropped reason=${reason} ${correlation}`);
      }
      return outcome;
    }),
  );
  if (outcomes.includes("woken")) return { outcome: "woken" };
  return { outcome: outcomes.includes("failed") ? "failed" : "dropped" };
}

// The hook tokens an event wakes, or null when it is not one that wakes. A
// GitHub status names only a commit, so it wakes the open pull requests at it.
// Slack sends the Events API body; its `event` is the message.
async function hookTokens(
  { provider, installationName, name, payload }: NamedEvent,
  context: FactoryContext,
): Promise<string[] | null> {
  if (provider === "slack") {
    const message = (payload as { event?: unknown } | null)?.event;
    const token = slackThreadTokenFromEvent(installationName, message);
    return token === null ? null : [token];
  }
  if (provider !== "github") return null;
  if (name !== "status") {
    const token = tokenFromGitHubPayload(installationName, payload);
    return token === null ? null : [token];
  }
  const status = githubStatus(payload);
  if (status === null || status.state === "pending") return null;
  const prs = await findOpenPullRequestsByHeadSha(
    { installationName, ...status.repository },
    status.sha,
    context,
  );
  return prs.map(pullRequestToken);
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
