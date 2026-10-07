import { createHook, sleep } from "workflow";
import type { ConversationMessage, TurnStepResult } from "../agents/conversation.ts";
import type { Harness } from "../agents/harness-config.ts";
import { JigsError } from "../errors.ts";
import {
  type LinearAgentActivityContent,
  type LinearAgentPrompt,
  type LinearAgentTurnRequest,
  linearSessionToken,
  stopAnswerKey,
} from "./agent-session.ts";
import { ClaimConflictError } from "./claim.ts";
import type { LinearAgentSessionInputs } from "./source.ts";

type SessionRef = { installationName: string; sessionId: string };

/**
 * The durable steps a Linear agent conversation runs.
 *
 * @group Factory plumbing
 */
export interface LinearAgentConversationSteps {
  executeLinearAgentTurn(request: LinearAgentTurnRequest): Promise<TurnStepResult>;
  listLinearAgentSessionPrompts(session: SessionRef): Promise<LinearAgentPrompt[]>;
  postLinearAgentActivity(
    request: SessionRef & { content: LinearAgentActivityContent; once?: string },
  ): Promise<unknown>;
  setLinearAgentSessionUrls(
    request: SessionRef & { urls: Array<{ label: string; url: string }> },
  ): Promise<void>;
}

/**
 * How a Linear agent conversation runs: the Claude harness and the worktree it works in.
 *
 * @remarks
 * `instructions` lead the first message Claude reads. The conversation ends once no one has
 * replied for `idleFor`, a duration such as `"30m"` or milliseconds; four hours by default.
 *
 * @group Linear agent sessions
 */
export interface LinearAgentConversationOptions {
  harness: Harness;
  cwd: string;
  instructions?: string;
  idleFor?: `${number}${"s" | "m" | "h" | "d"}` | number;
}

/**
 * How a Linear agent conversation ended, and how many turns it ran.
 *
 * @group Linear agent sessions
 */
export type LinearAgentConversationResult =
  | { outcome: "idle" | "stopped"; turns: number }
  | { outcome: "failed"; turns: number; error: string };

const STOPPED = "Stopped.";

/**
 * Hold a conversation with Claude in the Linear agent session that started this run, until no
 * one replies for `idleFor`, someone presses stop, or a turn fails.
 *
 * @remarks
 * Claude answers the mention that opened the session, then each reply, in the same session and
 * worktree. A reply sent while Claude works joins its turn. Linear shows a live status line while
 * Claude works, each answer as a response, a failure as an error, and a link to the run. A stop
 * ends the conversation with "Stopped.". Provision the worktree before calling this, and release
 * it after: the workflow keeps the worktree, the issue and anything it delivers, and runs on once
 * this returns. The trigger starts one run per session, and that run holds the session for the
 * whole conversation; a second run for the same session throws `ClaimConflictError` when it calls
 * this.
 *
 * @group Linear agent sessions
 */
export async function linearAgentConversation(
  session: LinearAgentSessionInputs,
  options: LinearAgentConversationOptions,
  steps: LinearAgentConversationSteps,
): Promise<LinearAgentConversationResult> {
  const { harness, cwd, instructions, idleFor = "4h" } = options;
  if (harness.kind !== "claude") {
    throw new JigsError(
      `a Linear agent conversation runs on a Claude harness, not ${harness.kind}`,
    );
  }
  const ref: SessionRef = {
    installationName: session.installationName,
    sessionId: session.session,
  };
  const token = linearSessionToken(ref.installationName, ref.sessionId);
  // Created once and held for the whole conversation: owning it makes this run the session's one
  // conversation, and each wake makes it read the session again.
  const hook = createHook<unknown>({ token });
  const conflict = await hook.getConflict();
  if (conflict !== null) throw new ClaimConflictError(token, conflict.runId);

  const linking = steps
    .setLinearAgentSessionUrls({ ...ref, urls: [] })
    .catch((error: unknown) => console.log(`[linearAgentConversation] no run link: ${error}`));
  const post = (content: LinearAgentActivityContent, once?: string) =>
    steps.postLinearAgentActivity({ ...ref, content, ...(once === undefined ? {} : { once }) });
  const consumed: string[] = [];
  const unread = async () =>
    (await steps.listLinearAgentSessionPrompts(ref)).filter((p) => !consumed.includes(p.id));
  const lastStop = (prompts: LinearAgentPrompt[]) =>
    prompts.findLast((prompt) => prompt.signal === "stop");
  let opening: ConversationMessage | undefined = {
    uuid: session.session,
    author: session.creator?.name ?? "Someone",
    text:
      session.comment ??
      `${session.issue.identifier} "${session.issue.title}" was assigned to you.`,
  };
  let turns = 0;

  const stopped = async (stop: LinearAgentPrompt | undefined) => {
    if (stop === undefined) throw new JigsError("the turn stopped, but the session holds no stop");
    await post({ type: "response", body: STOPPED }, stopAnswerKey(stop.id));
    return { outcome: "stopped" as const, turns };
  };
  const failed = async (error: string) => {
    await post({ type: "error", body: error });
    return { outcome: "failed" as const, turns, error };
  };

  try {
    // One timer per wait for a reply: the SDK cannot cancel it, so an old one may wake the run
    // once more, and is ignored.
    let idle: Promise<"idle"> | undefined;
    while (true) {
      const fresh = await unread();
      const stop = lastStop(fresh);
      if (stop !== undefined) return await stopped(stop);
      if (opening === undefined && fresh.length === 0) {
        // sleep's overloads take a duration string or milliseconds, but not their union.
        const wait = sleep as (duration: typeof idleFor) => Promise<void>;
        idle ??= wait(idleFor).then(() => "idle" as const);
        if ((await Promise.race([hook.then(() => "woken" as const), idle])) === "idle") {
          return { outcome: "idle", turns };
        }
        continue;
      }
      idle = undefined;
      const result = await steps.executeLinearAgentTurn({
        ...ref,
        harness,
        cwd,
        consumed: [...consumed],
        ...(instructions === undefined ? {} : { instructions }),
        ...(opening === undefined ? {} : { opening }),
      });
      if ("jitFailure" in result) {
        const checks = result.jitFailure.map(({ label, reason }) => `${label}: ${reason}`);
        return await failed(`Claude could not start:\n${checks.join("\n")}`);
      }
      consumed.push(...result.consumed);
      if (opening !== undefined && result.consumed.includes(opening.uuid)) opening = undefined;
      if (result.consumed.length > 0) turns += 1;
      if (result.outcome === "stopped") return await stopped(lastStop(await unread()));
      if (result.outcome === "failed") return await failed(result.error);
    }
  } catch (error) {
    // Without an error posted, Linear would show the session working until it went stale.
    await post({ type: "error", body: `The conversation failed: ${String(error)}` }).catch(
      () => {},
    );
    throw error;
  } finally {
    hook.dispose();
    await linking;
  }
}
