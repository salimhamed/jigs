// Before the ingress wakes a waiting run, Jev judges whether the delivery could
// matter to it. Every wake is safe, because a woken run re-reads provider state,
// but each one can cost an agent turn downstream. A skipped wake that did
// matter is still caught by the polling nudge, so only a confident "no" skips.

import { executeJev as executeJevStep } from "../steps/agents/execute-model-request.ts";
import { decide } from "../workflow/agents/decide.ts";
import { type ExecuteJevStep, type JevState, yesNo } from "../workflow/agents/jev.ts";

/** The confidence a "this event cannot matter" answer needs before a wake is skipped. */
export const WAKE_RELEVANCE_CUTOFF = 0.9;

/** Whether a webhook delivery could change what a run waiting on it should do. */
export const wakeRelevance = yesNo(
  "A software agent is waiting on this pull request or ticket, ready to respond to CI results, " +
    "reviews, questions, requested changes, and state changes. " +
    "Could this webhook event change what the agent should do next? " +
    "Answer no for events that carry nothing to act on: bot chatter, label or assignee shuffles, " +
    "edits to unrelated fields, reactions, or the agent's own status notes.",
);

// These always wake: they change the pull request's head, lifecycle or CI result.
const ALWAYS_WAKE: Record<string, Set<string>> = {
  pull_request: new Set(["closed", "reopened", "synchronize", "ready_for_review"]),
  check_suite: new Set(["completed"]),
};

/** What {@link wakeRelevance} is asked about: the event, trimmed to the fields that carry meaning. */
export function wakeEvidence(
  provider: "github" | "linear",
  event: string | null,
  payload: unknown,
): JevState | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : null;
  if (provider === "github") {
    if (event !== null && action !== null && ALWAYS_WAKE[event]?.has(action)) return null;
    return compact({
      provider,
      event,
      action,
      sender: pick(body.sender, ["login", "type"]),
      comment: pick(body.comment, ["body", "path"], (value) => truncate(value)),
      review: pick(body.review, ["state", "body"], (value) => truncate(value)),
      label: pick(body.label, ["name"]),
      changed: isRecord(body.changes) ? Object.keys(body.changes) : null,
    });
  }
  if (action === "remove") return null;
  return compact({
    provider,
    event,
    action,
    data: pick(body.data, ["body", "title", "state", "priority"], (value) => truncate(value)),
    changed: isRecord(body.updatedFrom) ? Object.keys(body.updatedFrom) : null,
  });
}

/**
 * Whether Jev is confident a delivery cannot matter to the run it would wake.
 *
 * @remarks
 * Off without an OpenRouter key, and a failed call counts as relevant: skipping a wake must be a
 * decision, never an accident.
 */
export async function isIrrelevantWake(
  provider: "github" | "linear",
  event: string | null,
  payload: unknown,
  executeJev: ExecuteJevStep = (wire) => executeJevStep(wire, { workflowRunId: "ingress" }),
): Promise<boolean> {
  if (!process.env.OPENROUTER_API_KEY) return false;
  const state = wakeEvidence(provider, event, payload);
  if (state === null) return false;
  try {
    const relevance = await decide(
      { site: "wake-relevance", state, question: wakeRelevance, cutoff: WAKE_RELEVANCE_CUTOFF },
      executeJev,
    );
    return relevance.confident && !relevance.yes;
  } catch (error) {
    console.log(`[ingress] wake relevance unavailable: ${String(error)}`);
    return false;
  }
}

type Json = JevState | string | number | boolean | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(
  value: unknown,
  keys: string[],
  map: (value: Json) => Json = (value) => value,
): Record<string, Json> | null {
  if (!isRecord(value)) return null;
  const picked: Record<string, Json> = {};
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" || typeof field === "number" || typeof field === "boolean")
      picked[key] = map(field);
  }
  return Object.keys(picked).length === 0 ? null : picked;
}

function truncate(value: Json): Json {
  return typeof value === "string" && value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
}

function compact(fields: Record<string, Json | string[] | Record<string, Json>>): JevState {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null),
  ) as JevState;
}
