// One turn of a conversation held in a Linear agent session: the replies it
// takes come from the session, and what it says goes back there.

import { derivedUuid } from "../../providers/linear.ts";
import { type LinearAgentApi, linearAgentFor } from "../../providers/linear-agent.ts";
import type { ConversationMessage, TurnStepResult } from "../../workflow/agents/conversation.ts";
import {
  type LinearAgentPrompt,
  type LinearAgentTurnRequest,
  linearSessionToken,
} from "../../workflow/linear/agent-session.ts";
import { executeTurn } from "../agents/shared/execute-turn.ts";
import type { AgentSourcePart } from "../agents/shared/step-stream.ts";
import type { TurnObserver } from "../agents/shared/types.ts";
import type { StepRunMetadata } from "../runtime/run-context.ts";

export type { LinearAgentTurnRequest };

/** How often the status line may change. */
export const STATUS_EVERY_MS = 5_000;
const REPLY_RETRY_MS = [1_000, 5_000, 15_000];
const COMMAND_CAP = 80;

type SessionApi = Pick<LinearAgentApi, "listPrompts" | "postActivity" | "postActivityOnce">;

/** What a Linear agent turn reaches. Tests replace it. */
export interface LinearAgentTurnDeps {
  executeTurn: typeof executeTurn;
  linear: (installationName: string) => SessionApi;
  wait: (ms: number) => Promise<void>;
}

const defaultDeps: LinearAgentTurnDeps = {
  executeTurn,
  linear: (installationName) => linearAgentFor(installationName),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Run one turn of a conversation in a Linear agent session.
 *
 * @remarks
 * The turn takes the opening mention, if given, and every reply in the session not in
 * `consumed`, so a retry takes the replies that arrived while the turn ran. A stop among them
 * ends the turn `stopped` before it starts. While the turn runs, a status line is posted as an
 * ephemeral thought, at most every five seconds, and each answer is posted as a response once
 * written.
 *
 * @group Linear agent sessions
 */
export async function executeLinearAgentTurn(
  request: LinearAgentTurnRequest,
  metadata: StepRunMetadata,
  deps: LinearAgentTurnDeps = defaultDeps,
): Promise<TurnStepResult> {
  const { installationName, sessionId, opening } = request;
  const linear = deps.linear(installationName);
  const consumed = new Set(request.consumed);
  const fresh = (await linear.listPrompts(sessionId)).filter((prompt) => !consumed.has(prompt.id));
  if (fresh.some((prompt) => prompt.signal === "stop")) {
    return { outcome: "stopped", replies: [], consumed: [] };
  }
  const messages = [...(opening === undefined ? [] : [opening]), ...fresh.map(asMessage)];
  if (messages.length === 0) return { outcome: "finished", replies: [], consumed: [] };
  const session = sessionPoster(linear, sessionId, metadata, deps.wait);
  try {
    return await deps.executeTurn(
      {
        harness: request.harness,
        cwd: request.cwd,
        conversation: linearSessionToken(installationName, sessionId),
        messages,
        ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
      },
      metadata,
      [session.observe],
    );
  } finally {
    await session.close();
  }
}

const asMessage = (prompt: LinearAgentPrompt): ConversationMessage => ({
  uuid: prompt.id,
  author: prompt.author.name,
  text: prompt.body,
});

// Every post goes through one queue, so a thought never lands after the answer
// that followed it. After an answer the status line stays quiet until the agent
// works again: a thought posted last would show the session as still working.
function sessionPoster(
  linear: SessionApi,
  sessionId: string,
  metadata: StepRunMetadata,
  wait: (ms: number) => Promise<void>,
) {
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (post: () => Promise<unknown>) => {
    queue = queue.then(post).catch(() => {});
  };
  let working = true;
  let last: string | undefined;
  let shown: string | undefined;
  let pending = false;
  const answers = new Map<string, number>();

  const tick = () => {
    if (!working || pending) return;
    const line = last === undefined ? "Working…" : `Working… (last: ${last})`;
    if (line === shown) return;
    shown = line;
    pending = true;
    enqueue(() =>
      linear
        .postActivity(sessionId, { type: "thought", body: line }, { ephemeral: true })
        .finally(() => {
          pending = false;
        }),
    );
  };

  const answer = (text: string) => {
    working = false;
    const body = text.trim() === "" ? "Done." : text;
    const seen = answers.get(text) ?? 0;
    answers.set(text, seen + 1);
    // Named by its text, so a retried turn that gives the same answer posts it once.
    const id = derivedUuid([
      "linear-agent-answer",
      metadata.workflowRunId,
      metadata.stepId,
      text,
      String(seen),
    ]);
    enqueue(async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await linear.postActivityOnce(sessionId, { type: "response", body }, id);
        } catch (error) {
          const delay = REPLY_RETRY_MS[attempt];
          if (delay === undefined) {
            console.error(`[linear] could not post an answer in session ${sessionId}: ${error}`);
            return;
          }
          await wait(delay);
        }
      }
    });
  };

  const timer = setInterval(tick, STATUS_EVERY_MS);
  const observe: TurnObserver = (event) => {
    if (event.type === "start") tick();
    else if (event.type === "reply") answer(event.text);
    else if (isWork(event.part)) {
      working = true;
      if (event.part.type === "tool-call") last = describeTool(event.part);
    }
  };
  return {
    observe,
    async close() {
      clearInterval(timer);
      working = false;
      await queue;
    },
  };
}

const isWork = (part: AgentSourcePart) =>
  part.type === "tool-call" ||
  part.type === "tool-result" ||
  part.type === "tool-error" ||
  part.type === "text-delta" ||
  part.type === "reasoning-delta";

function describeTool(part: Extract<AgentSourcePart, { type: "tool-call" }>): string {
  const command = (part.input as { command?: unknown } | undefined)?.command;
  if (part.toolName !== "Bash" || typeof command !== "string" || command === "") {
    return `used ${part.toolName}`;
  }
  const line = command.split("\n")[0] ?? "";
  return `ran \`${line.length > COMMAND_CAP ? `${line.slice(0, COMMAND_CAP)}…` : line}\``;
}
