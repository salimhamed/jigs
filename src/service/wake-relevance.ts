// Before the ingress wakes a waiting run, Jev judges whether the delivery could
// matter to it. Every wake is safe, because a woken run re-reads provider state,
// but each one can cost an agent turn downstream. A skipped wake that did
// matter is still caught by the polling nudge, so only a confident "no" skips.

import { getHookByToken } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { getComment } from "../providers/linear.ts";
import { executeJev as executeJevStep } from "../steps/agents/execute-model-request.ts";
import { decide } from "../workflow/agents/decide.ts";
import { type ExecuteJevStep, type JevState, yesNo } from "../workflow/agents/jev.ts";
import { carriesMarker } from "../workflow/pull-requests/marker.ts";
import { PULL_REQUEST_TOKEN_PREFIX } from "../workflow/pull-requests/pull-request.ts";
import { needsHumanParts } from "./runs.ts";
import { lastWake } from "./wake-note.ts";

/** The confidence a "this event cannot matter" answer needs before a wake is skipped. */
export const WAKE_RELEVANCE_CUTOFF = 0.9;

/** Whether a webhook delivery could change what a run waiting on it should do. */
export const wakeRelevance = yesNo(
  "Should this webhook event wake the paused run described in `waiting`? " +
    "Yes if the event is something the run is waiting for or must respond to: a review, requested " +
    "changes, a human question, or an answer to the run's open question. " +
    "No if it is noise for this run: a bot report, a label, assignee or priority change, a " +
    "reaction, a note the run posted itself (`fromJigs`), or a comment on a ticket where the run " +
    "has no question open.",
);

/** What the paused run is waiting for, as {@link wakeRelevance} reads it. */
export type Waiting =
  | {
      for: "pull request activity";
      pullRequest: string;
      reactsTo: string;
      head?: string;
      draft?: boolean;
      lastWake?: string;
    }
  | { for: "a human reply"; question: string | null }
  | { for: "nothing on this ticket"; note: string }
  | { for: "unknown" };

/** How {@link isIrrelevantWake} asks Jev and learns what the run is waiting for. */
export interface WakeRelevanceDeps {
  executeJev: ExecuteJevStep;
  /** Null when no run holds the token, so there is nothing to wake. */
  readWaiting: (token: string, payload: unknown) => Promise<Waiting | null>;
}

// These always wake: they change the pull request's head, lifecycle or CI result.
const ALWAYS_WAKE: Record<string, Set<string>> = {
  pull_request: new Set(["closed", "reopened", "synchronize", "ready_for_review"]),
  check_suite: new Set(["completed"]),
};

const PULL_REQUEST_REACTS_TO =
  "CI results, reviews, review comments and conversation comments that ask for changes or answers, merges and closes";

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
    const text = field(body.comment, "body") ?? field(body.review, "body");
    return compact({
      provider,
      event,
      action,
      sender: pick(body.sender, ["login", "type"]),
      comment: pick(body.comment, ["body", "path"], (value) => truncate(value)),
      review: pick(body.review, ["state", "body"], (value) => truncate(value)),
      label: pick(body.label, ["name"]),
      changed: isRecord(body.changes) ? Object.keys(body.changes) : null,
      fromJigs: text !== null && carriesMarker(text) ? true : null,
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

/** The state Jev judges: the event beside what the run it would wake is waiting for. */
export function wakeState(event: JevState, waiting: Waiting): JevState {
  return { event, waiting } as JevState;
}

/**
 * What the run holding this token is waiting for. A pull request token names its own wait; a
 * ticket token is a wait only while the run has a question open, which the World's hooks say
 * and Linear's copy of the question explains.
 */
export async function readWaiting(token: string, payload: unknown): Promise<Waiting | null> {
  const runId = await getHookByToken(token).then(
    (hook) => hook.runId,
    () => null,
  );
  if (runId === null) return null;
  if (token.startsWith(PULL_REQUEST_TOKEN_PREFIX)) return pullRequestWaiting(token, runId, payload);
  const tokens = await getWorld()
    .then((world) => world.hooks.list({ runId }))
    .then(
      (page) => page.data.map((hook) => hook.token),
      () => null,
    );
  if (tokens === null) return { for: "unknown" };
  const halt = tokens.map(needsHumanParts).find((parts) => parts !== null);
  if (halt === undefined)
    return {
      for: "nothing on this ticket",
      note: "The run is working and has no question open on this ticket.",
    };
  const question = await getComment(halt.commentId).then(
    (comment) => clip(comment.body),
    () => null,
  );
  return { for: "a human reply", question };
}

function pullRequestWaiting(token: string, runId: string, payload: unknown): Waiting {
  const pr = isRecord(payload) && isRecord(payload.pull_request) ? payload.pull_request : null;
  const head = pr === null ? null : field(pr.head, "sha");
  const wake = lastWake(token, runId);
  return {
    for: "pull request activity",
    pullRequest: token.slice(PULL_REQUEST_TOKEN_PREFIX.length),
    reactsTo: PULL_REQUEST_REACTS_TO,
    ...(head === null ? {} : { head: head.slice(0, 7) }),
    ...(pr !== null && typeof pr.draft === "boolean" ? { draft: pr.draft } : {}),
    ...(wake === undefined ? {} : { lastWake: `${wake.kind} at ${wake.at}` }),
  };
}

const defaultDeps: WakeRelevanceDeps = {
  executeJev: (wire) => executeJevStep(wire, { workflowRunId: "ingress" }),
  readWaiting,
};

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
  token: string,
  deps: Partial<WakeRelevanceDeps> = {},
): Promise<boolean> {
  if (!process.env.OPENROUTER_API_KEY) return false;
  const evidence = wakeEvidence(provider, event, payload);
  if (evidence === null) return false;
  const { executeJev, readWaiting: read } = { ...defaultDeps, ...deps };
  try {
    const waiting = await read(token, payload);
    if (waiting === null) return false;
    const relevance = await decide(
      {
        site: "wake-relevance",
        state: wakeState(evidence, waiting),
        question: wakeRelevance,
        cutoff: WAKE_RELEVANCE_CUTOFF,
      },
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

function field(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const found = value[key];
  return typeof found === "string" ? found : null;
}

function pick(
  value: unknown,
  keys: string[],
  map: (value: Json) => Json = (value) => value,
): Record<string, Json> | null {
  if (!isRecord(value)) return null;
  const picked: Record<string, Json> = {};
  for (const key of keys) {
    const found = value[key];
    if (typeof found === "string" || typeof found === "number" || typeof found === "boolean")
      picked[key] = map(found);
  }
  return Object.keys(picked).length === 0 ? null : picked;
}

function clip(value: string): string {
  return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
}

function truncate(value: Json): Json {
  return typeof value === "string" ? clip(value) : value;
}

function compact(fields: Record<string, Json | string[] | Record<string, Json>>): JevState {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null),
  ) as JevState;
}
