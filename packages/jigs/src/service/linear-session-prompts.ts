// A reply or a stop in a Linear agent session goes to the run conversing in it.
// The session's token keys both that run's hook and its live turn.

import { z } from "zod";
import { derivedUuid, linearFor } from "../providers/linear.ts";
import { type LinearAgentApi, linearAgentFor } from "../providers/linear-agent.ts";
import { liveTurn } from "../steps/agents/shared/live-turns.ts";
import { linearSessionToken } from "../workflow/linear/agent-session.ts";
import { recordedOccurrences, withdrawOccurrence } from "./event-triggers/runner.ts";
import type { Occurrence } from "./event-triggers/store.ts";
import { cancelRun, runStatuses } from "./runs.ts";
import { wake } from "./wake.ts";

const promptedSchema = z.object({
  agentSession: z.object({ id: z.string().min(1) }),
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

/** What routing a session's prompts reaches. Tests replace it; the service uses the defaults. */
export interface SessionPromptDeps {
  liveTurn: typeof liveTurn;
  wake: typeof wake;
  linear: (installationName: string) => Pick<LinearAgentApi, "postActivityOnce" | "answeredSince">;
  appName: (installationName: string) => Promise<string>;
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
  recorded: recordedOccurrences,
  withdraw: withdrawOccurrence,
  runStatuses,
  cancelRun,
  later(fire, ms) {
    setTimeout(fire, ms).unref?.();
  },
};

/** What routing a prompt did, in the outcomes provider event routing reports. */
export type PromptRoute = "ignored" | "woken" | "dropped" | "failed";

/**
 * Where a session stands in this factory. `none`: no trigger here started it. `open`: a run of it
 * is live or may still start. `ended`: every run of it is over.
 */
type SessionState = { state: "none" | "ended" } | { state: "open"; liveRuns: string[] };

// Stops whose fallback is waiting, so an event routed again arms no second one.
const pendingStops = new Set<string>();

/**
 * Hand a `prompted` agent session event to the run conversing in the session: into its live turn
 * when one runs in this process, and through its hook either way, so a parked run reads the
 * session again. A session whose runs have ended is told so, and a stop no run takes in time is
 * ended here.
 */
export async function routeSessionPrompt(
  installationName: string,
  payload: unknown,
  deps: SessionPromptDeps = sessionPromptDeps,
): Promise<PromptRoute> {
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
  // messages after it, and the wake makes the parked run read them again.
  const woke = await deps.wake(token, "linear AgentSessionEvent");
  const at = `${stop ? "stop" : "reply"} session=${session.sessionId} activity=${prompt.id}`;
  if (woke.outcome === "failed") {
    console.log(`[events] linear dropped reason=delivery-failed ${at}`);
    return "failed";
  }
  const reached = live !== undefined || woke.outcome === "woken";
  if (reached && !stop) {
    console.log(`[events] linear accepted ${at}`);
    return "woken";
  }
  let state: SessionState;
  try {
    state = await sessionState(session, deps, { withdraw: stop });
  } catch (error) {
    console.log(`[events] linear dropped reason=session-lookup-failed ${at}: ${String(error)}`);
    return "failed";
  }
  if (reached || state.state === "open") {
    console.log(`[events] linear ${reached ? "accepted" : "dropped reason=run-not-parked"} ${at}`);
    if (stop) awaitStop(session, prompt, deps);
    return reached ? "woken" : "dropped";
  }
  if (state.state === "none") {
    console.log(`[events] linear ignored reason=not-this-factorys-session ${at}`);
    return "ignored";
  }
  console.log(`[events] linear dropped reason=conversation-ended ${at}`);
  try {
    if (stop) await postStopped(session, prompt, deps);
    else
      await deps
        .linear(installationName)
        .postActivityOnce(
          session.sessionId,
          { type: "response", body: await endedMessage(installationName, deps) },
          derivedUuid(["linear-session-ended", prompt.id]),
        );
  } catch (error) {
    console.error(`[linear] could not answer agent session ${session.sessionId}: ${String(error)}`);
    return "failed";
  }
  return "dropped";
}

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
      derivedUuid(["linear-session-stopped", stop.id]),
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
  const liveRuns = runIds.filter((runId) =>
    ["pending", "running"].includes(statuses.get(runId) ?? ""),
  );
  return liveRuns.length > 0 || unstarted ? { state: "open", liveRuns } : { state: "ended" };
}

// A failed start that was attempted can still turn out to have started a run.
const mayStillStart = (row: Occurrence) =>
  row.state === "pending" ||
  (row.state === "failed" && row.attemptedAt !== null && row.runId === null);

// A run that takes the stop posts its own final activity. When none has after
// the grace period, the service cancels every run of the session, since a
// cancelled run runs no more code, and posts the final activity Linear waits
// for to leave `stopping`.
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
  if (await linear.answeredSince(session.sessionId, stop.createdAt)) return;
  const state = await sessionState(session, deps, { withdraw: true });
  for (const runId of state.state === "open" ? state.liveRuns : []) {
    console.log(
      `[linear] cancelling run ${runId}: it did not take the stop in session ${session.sessionId}`,
    );
    await deps.cancelRun(runId);
  }
  await postStopped(session, stop, deps);
}
