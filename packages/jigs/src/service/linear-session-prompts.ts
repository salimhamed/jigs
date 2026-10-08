// A reply or a stop in a Linear agent session goes to the run that holds the
// session: into its live turn, or through its listening hook while it reads
// the session. The session's own token keys the live turn and finds the run.

import { getHookByToken } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { z } from "zod";
import { derivedUuid, linearFor } from "../providers/linear.ts";
import { type LinearAgentApi, linearAgentFor, onceActivityId } from "../providers/linear-agent.ts";
import { liveTurn } from "../steps/agents/shared/live-turns.ts";
import {
  linearListeningToken,
  linearSessionToken,
  stopAnswerKey,
} from "../workflow/linear/agent-session.ts";
import { recordedOccurrences, withdrawOccurrence } from "./event-triggers/runner.ts";
import type { Occurrence } from "./event-triggers/store.ts";
import { cancelRun, runStatuses } from "./runs.ts";
import { wake } from "./wake.ts";

const headSchema = z.object({
  type: z.literal("AgentSessionEvent"),
  action: z.literal("prompted"),
});

const promptedSchema = z.object({
  // No creator: the app opened the session itself, for a ticket run.
  agentSession: z.object({ id: z.string().min(1), creatorId: z.string().nullish() }),
  agentActivity: z.object({
    id: z.string().min(1),
    createdAt: z.string(),
    signal: z.string().nullish(),
    content: z.object({ body: z.string().nullish() }),
    user: z.object({ name: z.string() }).nullish(),
  }),
});

type Prompt = z.infer<typeof promptedSchema>["agentActivity"];

/** How long a run has to answer a stop before the service ends the session itself. */
export const STOP_GRACE_MS = 30_000;

// Waits before the fallback tries again. Past them, Linear ends a session still
// stopping on its own after five minutes.
const STOP_RETRY_MS = [5_000, 15_000];

const STOPPED = "Stopped.";

const WORKING =
  "I'm working and can't take instructions mid-run; I'll ask here if I need you. Use Stop to end the run.";

const WAITING =
  "I can't take instructions here while I wait; my earlier message says where to act.";

/** What routing a session's prompts reaches. Tests replace it; the service uses the defaults. */
export interface SessionPromptDeps {
  liveTurn: typeof liveTurn;
  wake: typeof wake;
  linear: (
    installationName: string,
  ) => Pick<LinearAgentApi, "postActivityOnce" | "findActivity" | "lastAppActivity">;
  appName: (installationName: string) => Promise<string>;
  /** The run holding this hook token, or null when none does. It may have ended since. */
  holder: (token: string) => Promise<string | null>;
  recorded: typeof recordedOccurrences;
  withdraw: typeof withdrawOccurrence;
  runStatuses: typeof runStatuses;
  cancelRun: typeof cancelRun;
  later: (fire: () => void, ms: number) => void;
}

export const sessionPromptDeps: SessionPromptDeps = {
  liveTurn,
  wake,
  linear: (installationName) => linearAgentFor(installationName),
  appName: async (installationName) => (await linearFor(installationName).appUser()).name,
  holder: async (token) => {
    try {
      return (await getHookByToken(token)).runId;
    } catch (error) {
      if (HookNotFoundError.is(error)) return null;
      throw error;
    }
  },
  recorded: recordedOccurrences,
  withdraw: withdrawOccurrence,
  runStatuses,
  cancelRun,
  later(fire, ms) {
    setTimeout(fire, ms).unref?.();
  },
};

/** What routing a prompt did, in the outcomes provider event routing reports. Throws when it could not tell. */
export type PromptRoute = "ignored" | "woken" | "dropped";

/**
 * Where a session stands in this factory. `none`: no trigger here started it. `open`: a run of it
 * is live or may still start. `ended`: every run of it is over.
 */
type SessionState = { state: "none" | "ended" } | { state: "open"; liveRuns: string[] };

// Stops whose fallback is waiting, so an event routed again arms no second one.
const pendingStops = new Set<string>();

/**
 * Hand a `prompted` agent session event to the run that holds the session: into its live turn
 * when one runs in this process, and through its listening hook, so a run reading the session
 * reads it again. A run that holds the session but is not listening is working or waiting on
 * people, and the person is told so. A session whose runs have ended is told so too, including
 * a session the app opened for a ticket run that has ended, and a stop no run takes in time is
 * ended here. Any other event is ignored.
 */
export async function routeSessionPrompt(
  {
    provider,
    installationName,
    payload,
  }: { provider: string; installationName: string; payload: unknown },
  deps: SessionPromptDeps = sessionPromptDeps,
): Promise<PromptRoute> {
  if (provider !== "linear" || !headSchema.safeParse(payload).success) return "ignored";
  const parsed = promptedSchema.safeParse(payload);
  if (!parsed.success) {
    console.error(
      `[linear] ignored an agent session prompt it could not read: ${parsed.error.message}`,
    );
    return "ignored";
  }
  const { agentSession, agentActivity: prompt } = parsed.data;
  const session = { installationName, sessionId: agentSession.id };
  const token = linearSessionToken(installationName, session.sessionId);
  const stop = prompt.signal === "stop";
  const live = deps.liveTurn(token);
  // Every other signal is a reply: its body is what the person chose or said.
  if (stop) live?.stop();
  else
    live?.inject({
      uuid: prompt.id,
      author: prompt.user?.name ?? "Someone",
      text: prompt.content.body ?? "",
    });
  // Woken even when the live turn took the message: one that fails drops the
  // messages after it, and the wake makes the listening run read them again.
  const woke = await deps.wake(
    linearListeningToken(installationName, session.sessionId),
    "linear AgentSessionEvent",
  );
  if (woke.outcome === "failed") throw new Error(`could not wake the listening run: ${woke.error}`);
  const at = `${stop ? "stop" : "reply"} session=${session.sessionId} activity=${prompt.id}`;
  if (live !== undefined || woke.outcome === "woken") {
    console.log(`[events] linear accepted ${at}`);
    if (stop) awaitStop(session, prompt, deps);
    return "woken";
  }
  const appOpened = !agentSession.creatorId;
  const holder = await deps.holder(token);
  const state =
    holder === null && !appOpened
      ? await sessionState(session, deps, { withdraw: stop })
      : undefined;
  if (holder !== null && stop) {
    console.log(`[events] linear dropped reason=run-not-listening ${at} run=${holder}`);
    awaitStop(session, prompt, deps);
    return "dropped";
  }
  if (holder !== null) {
    // The message stays in the session, and the run reads it when it next listens. The app
    // having posted since the message means the run already took it: a reply to its question
    // that landed as the run stopped listening. A response last means the run is finishing, so
    // nothing is posted after its final message. A run left awaiting input is waiting on
    // people, since a question always listens, so its reply asks again to keep the session
    // awaiting input.
    const linear = deps.linear(installationName);
    const last = await linear.lastAppActivity(session.sessionId);
    if (last !== null && Date.parse(last.createdAt) > Date.parse(prompt.createdAt)) {
      console.log(`[events] linear accepted ${at} run=${holder} answered`);
      return "woken";
    }
    if (last?.type === "response") {
      console.log(`[events] linear accepted ${at} run=${holder} finishing`);
      return "woken";
    }
    const waiting = last?.type === "elicitation";
    await linear.postActivityOnce(
      session.sessionId,
      waiting ? { type: "elicitation", body: WAITING } : { type: "thought", body: WORKING },
      derivedUuid([waiting ? "linear-session-waiting" : "linear-session-working", prompt.id]),
    );
    console.log(
      `[events] linear accepted ${at} run=${holder} ${waiting ? "waiting" : "not listening"}`,
    );
    return "woken";
  }
  if (appOpened) return answerEndedTicketRun(session, prompt, at, deps);
  if (state?.state === "open") {
    console.log(`[events] linear dropped reason=run-not-parked ${at}`);
    if (stop) awaitStop(session, prompt, deps);
    return "dropped";
  }
  if (state?.state === "none") {
    console.log(`[events] linear ignored reason=not-this-factorys-session ${at}`);
    return "ignored";
  }
  console.log(`[events] linear dropped reason=conversation-ended ${at}`);
  if (stop) await postStopped(session, prompt, deps);
  else
    await deps
      .linear(installationName)
      .postActivityOnce(
        session.sessionId,
        { type: "response", body: await endedMessage(installationName, deps) },
        derivedUuid(["linear-session-ended", prompt.id]),
      );
  return "dropped";
}

// A session the app opened is a ticket run's, and only an ended run leaves a response as the
// app's last activity: a live one's is a thought or an elicitation, so another factory's live
// session is never answered. Factories sharing the app post under the same id, so one reply shows.
// Accepted risk: a note's response and its "Still working." thought are two posts in one step,
// so if the thought fails and retries, a factory sharing the app can briefly see a lone response.
async function answerEndedTicketRun(
  { installationName, sessionId }: { installationName: string; sessionId: string },
  prompt: Prompt,
  at: string,
  deps: SessionPromptDeps,
): Promise<PromptRoute> {
  const linear = deps.linear(installationName);
  const last = await linear.lastAppActivity(sessionId);
  if (last?.type !== "response") {
    console.log(`[events] linear ignored reason=not-this-factorys-session ${at}`);
    return "ignored";
  }
  const app = await deps.appName(installationName).catch(() => null);
  const start =
    app === null
      ? "Assign the issue to the app or mention it"
      : `Assign the issue to @${app} or mention @${app}`;
  await linear.postActivityOnce(
    sessionId,
    { type: "response", body: `This conversation has ended. ${start} to start a new run.` },
    derivedUuid(["linear-ticket-session-ended", prompt.id]),
  );
  console.log(`[events] linear dropped reason=run-ended ${at}`);
  return "dropped";
}

const isLive = (status: string | undefined) => status === "pending" || status === "running";

async function endedMessage(installationName: string, deps: SessionPromptDeps): Promise<string> {
  const app = await deps.appName(installationName).catch(() => null);
  const mention = app === null ? "mention the app again" : `mention @${app} again`;
  return `This conversation has ended; ${mention} to start a new one.`;
}

// One "Stopped." per stop, whether the route or the fallback posts it.
function postStopped(
  { installationName, sessionId }: { installationName: string; sessionId: string },
  stop: Prompt,
  deps: SessionPromptDeps,
) {
  return deps
    .linear(installationName)
    .postActivityOnce(
      sessionId,
      { type: "response", body: STOPPED },
      onceActivityId(sessionId, stopAnswerKey(stop.id)),
    );
}

// Only a session one of this factory's triggers started in this installation
// is this factory's to answer: another factory may share the app. On a stop,
// a run not yet claimed for starting is withdrawn, so it never starts.
async function sessionState(
  { installationName, sessionId }: { installationName: string; sessionId: string },
  deps: SessionPromptDeps,
  options: { withdraw: boolean },
): Promise<SessionState> {
  const rows = (await deps.recorded("linear", sessionId)).filter(
    (row) => row.inputs.installationName === installationName,
  );
  if (rows.length === 0) return { state: "none" };
  let unstarted = false;
  for (const row of rows) {
    if (row.state === "pending" && row.attemptedAt === null && options.withdraw) {
      if (await deps.withdraw(row)) continue;
      unstarted = true;
    } else if (mayStillStart(row)) unstarted = true;
  }
  const runIds = rows.flatMap((row) => (row.runId === null ? [] : [row.runId]));
  const statuses = await deps.runStatuses(runIds);
  const liveRuns = runIds.filter((runId) => isLive(statuses.get(runId)));
  return liveRuns.length > 0 || unstarted ? { state: "open", liveRuns } : { state: "ended" };
}

// A failed start that was attempted can still turn out to have started a run.
const mayStillStart = (row: Occurrence) =>
  row.state === "pending" ||
  (row.state === "failed" && row.attemptedAt !== null && row.runId === null);

// A run that takes the stop posts its own final activity. When none has after
// the grace period, the service cancels the run holding the session and every
// live run of it a trigger started, since a cancelled run runs no more code,
// and posts the final activity Linear waits for to leave `stopping`.
function awaitStop(
  session: { installationName: string; sessionId: string },
  stop: Prompt,
  deps: SessionPromptDeps,
): void {
  if (pendingStops.has(stop.id)) return;
  pendingStops.add(stop.id);
  const attempt = (tries: number) => {
    endUntakenStop(session, stop, deps).then(
      () => pendingStops.delete(stop.id),
      (error: unknown) => {
        const wait = STOP_RETRY_MS[tries];
        if (wait !== undefined) {
          deps.later(() => attempt(tries + 1), wait);
          return;
        }
        pendingStops.delete(stop.id);
        console.error(
          `[linear] could not end agent session ${session.sessionId} after a stop: ${String(error)}`,
        );
      },
    );
  };
  deps.later(() => attempt(0), STOP_GRACE_MS);
}

async function endUntakenStop(
  session: { installationName: string; sessionId: string },
  stop: Prompt,
  deps: SessionPromptDeps,
): Promise<void> {
  const linear = deps.linear(session.installationName);
  // Only the stop's own answer counts: a ticket run's ordinary notes are responses too.
  if (
    (await linear.findActivity(onceActivityId(session.sessionId, stopAnswerKey(stop.id)))) !== null
  )
    return;
  const holder = await deps.holder(linearSessionToken(session.installationName, session.sessionId));
  const state = await sessionState(session, deps, { withdraw: true });
  const runs = new Set(holder === null ? [] : [holder]);
  for (const runId of state.state === "open" ? state.liveRuns : []) runs.add(runId);
  for (const runId of runs) {
    console.log(
      `[linear] cancelling run ${runId}: it did not take the stop in session ${session.sessionId}`,
    );
    await deps.cancelRun(runId);
  }
  // A run that ended on its own during the grace period already posted its final message.
  if (runs.size === 0) {
    const last = await linear.lastAppActivity(session.sessionId);
    if ((last?.type === "response" || last?.type === "error") && last.createdAt > stop.createdAt)
      return;
  }
  await postStopped(session, stop, deps);
}
