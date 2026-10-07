// A reply or a stop in a Linear agent session goes to the run conversing in it.
// The session's token keys both that run's hook and its live turn.

import { getHookByToken } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { z } from "zod";
import { linearFor } from "../providers/linear.ts";
import { type LinearAgentApi, linearAgentFor } from "../providers/linear-agent.ts";
import { liveTurn } from "../steps/agents/shared/live-turns.ts";
import { linearSessionToken } from "../workflow/linear/agent-session.ts";
import { recordedOccurrences } from "./event-triggers/runner.ts";
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

/** How long a run has to answer a stop before the service ends the session itself. */
export const STOP_GRACE_MS = 30_000;

const STOPPED = "Stopped.";

type SessionHolder = { state: "none" | "starting" | "running" | "ended" };

/** What routing a session's prompts reaches. Tests replace it; the service uses the defaults. */
export interface SessionPromptDeps {
  liveTurn: typeof liveTurn;
  wake: typeof wake;
  linear: (installationName: string) => Pick<LinearAgentApi, "postActivity" | "answeredSince">;
  appName: (installationName: string) => Promise<string>;
  recorded: typeof recordedOccurrences;
  runStatuses: typeof runStatuses;
  hookRun: (token: string) => Promise<string | null>;
  cancelRun: typeof cancelRun;
  later: (fire: () => void, ms: number) => void;
}

export const sessionPromptDeps: SessionPromptDeps = {
  liveTurn,
  wake,
  linear: (installationName) => linearAgentFor(installationName),
  appName: async (installationName) => (await linearFor(installationName).appUser()).name,
  recorded: recordedOccurrences,
  runStatuses,
  async hookRun(token) {
    try {
      return (await getHookByToken(token)).runId;
    } catch (error) {
      if (HookNotFoundError.is(error)) return null;
      throw error;
    }
  },
  cancelRun,
  later(fire, ms) {
    setTimeout(fire, ms).unref?.();
  },
};

/** What routing a prompt did, in the outcomes provider event routing reports. */
export type PromptRoute = "ignored" | "woken" | "dropped" | "failed";

// Stops whose fallback is waiting, so an event routed again schedules no second one.
const pendingStops = new Set<string>();

/**
 * Hand a `prompted` agent session event to the run conversing in the session: into its live turn
 * when one runs in this process, and through its hook either way, so a parked run reads the
 * session again. A session whose run has ended is told so, and a stop no run takes in time is
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
  const { agentSession, agentActivity: activity } = parsed.data;
  const sessionId = agentSession.id;
  const token = linearSessionToken(installationName, sessionId);
  const stop = activity.signal === "stop";
  const live = deps.liveTurn(token);
  // Every other signal is a reply: its body is what the person chose or said.
  if (stop) live?.stop();
  else
    live?.inject({
      uuid: activity.id,
      author: activity.user?.name ?? "Someone",
      text: activity.content.body ?? "",
    });
  // Woken even when the live turn took the message: one that fails drops the
  // messages after it, and the wake makes the parked run read them again.
  const woke = await deps.wake(token, "linear AgentSessionEvent");
  const at = `${stop ? "stop" : "reply"} session=${sessionId} activity=${activity.id}`;
  if (woke.outcome === "failed") {
    console.log(`[events] linear dropped reason=delivery-failed ${at}`);
    return "failed";
  }
  if (live !== undefined || woke.outcome === "woken") {
    console.log(`[events] linear accepted ${at}`);
    if (stop) awaitStop(installationName, sessionId, activity, deps);
    return "woken";
  }
  let holder: SessionHolder;
  try {
    holder = await sessionHolder(sessionId, deps);
  } catch (error) {
    console.log(`[events] linear dropped reason=session-lookup-failed ${at}: ${String(error)}`);
    return "failed";
  }
  switch (holder.state) {
    case "none":
      console.log(`[events] linear ignored reason=not-this-factorys-session ${at}`);
      return "ignored";
    // Its run reads the session once it gets to its hook.
    case "starting":
    case "running":
      console.log(`[events] linear dropped reason=run-not-parked ${at}`);
      if (stop) awaitStop(installationName, sessionId, activity, deps);
      return "dropped";
    case "ended":
      console.log(`[events] linear dropped reason=conversation-ended ${at}`);
      await post(
        installationName,
        sessionId,
        stop ? STOPPED : await endedMessage(installationName, deps),
        deps,
      );
      return "dropped";
  }
}

async function endedMessage(installationName: string, deps: SessionPromptDeps): Promise<string> {
  const app = await deps.appName(installationName).catch(() => null);
  const mention = app === null ? "mention the app again" : `mention @${app} again`;
  return `This conversation has ended; ${mention} to start a new one.`;
}

async function post(
  installationName: string,
  sessionId: string,
  body: string,
  deps: SessionPromptDeps,
): Promise<void> {
  try {
    await deps.linear(installationName).postActivity(sessionId, { type: "response", body });
  } catch (error) {
    console.error(`[linear] could not answer agent session ${sessionId}: ${String(error)}`);
  }
}

// Only a session one of this factory's triggers started is this factory's to
// answer: another factory may share the app and hold the session.
async function sessionHolder(sessionId: string, deps: SessionPromptDeps): Promise<SessionHolder> {
  const rows = await deps.recorded("linear", sessionId);
  if (rows.length === 0) return { state: "none" };
  if (rows.some((row) => row.state === "pending")) return { state: "starting" };
  const runIds = rows.flatMap((row) => (row.runId === null ? [] : [row.runId]));
  const statuses = await deps.runStatuses(runIds);
  const running = runIds.some((runId) =>
    ["pending", "running"].includes(statuses.get(runId) ?? ""),
  );
  return { state: running ? "running" : "ended" };
}

// A run that takes the stop posts its own final activity. One that does not
// in time is cancelled, and a cancelled run runs no more code, so the service
// posts the final activity Linear waits for to leave `stopping`.
function awaitStop(
  installationName: string,
  sessionId: string,
  stop: { id: string; createdAt: string },
  deps: SessionPromptDeps,
): void {
  if (pendingStops.has(stop.id)) return;
  pendingStops.add(stop.id);
  deps.later(() => {
    void endUntakenStop(installationName, sessionId, stop.createdAt, deps)
      .catch((error: unknown) => {
        console.error(
          `[linear] could not end agent session ${sessionId} after a stop: ${String(error)}`,
        );
      })
      .finally(() => pendingStops.delete(stop.id));
  }, STOP_GRACE_MS);
}

async function endUntakenStop(
  installationName: string,
  sessionId: string,
  stoppedAt: string,
  deps: SessionPromptDeps,
): Promise<void> {
  if (await deps.linear(installationName).answeredSince(sessionId, stoppedAt)) return;
  const runId = await deps.hookRun(linearSessionToken(installationName, sessionId));
  if (runId !== null) {
    console.log(
      `[linear] cancelling run ${runId}: it did not take the stop in session ${sessionId}`,
    );
    await deps.cancelRun(runId);
  }
  await post(installationName, sessionId, STOPPED, deps);
}
