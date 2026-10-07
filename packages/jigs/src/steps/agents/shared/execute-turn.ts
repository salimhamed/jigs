import { JigsError } from "../../../errors.ts";
import { withRunCancellation } from "../../../run-cancellation.ts";
import { JitCheckError } from "../../../workflow/agents/agent.ts";
import type {
  TurnRequest,
  TurnResult,
  TurnStepResult,
} from "../../../workflow/agents/conversation.ts";
import type { Harness } from "../../../workflow/agents/harness-config.ts";
import type { RunMetadata } from "../../runtime/run-context.ts";
import { prepareAgentRun } from "./runner.ts";
import { type ExecutionSeams, executionSeams } from "./seams.ts";
import { createStreamTap } from "./step-stream.ts";
import type { Driver, TurnEvent, TurnObserver } from "./types.ts";

/**
 * Run one turn of a conversation in a worktree, with the checks, environment, lock and run
 * cancellation of an agent step. While it runs, `liveTurn(request.conversation)` takes more
 * messages and stops it. `observers` see its activity; their failures are ignored. A failed
 * just-in-time check comes back as `{ jitFailure }`, as from the agent step.
 */
export function executeTurn(
  request: TurnRequest,
  metadata: RunMetadata,
  observers: readonly TurnObserver[] = [],
): Promise<TurnStepResult> {
  return executeTurnWith(request, metadata, observers, executionSeams);
}

export async function executeTurnWith(
  request: TurnRequest,
  metadata: RunMetadata,
  observers: readonly TurnObserver[],
  seams: ExecutionSeams,
): Promise<TurnStepResult> {
  const driver = seams.resolveDriver(request.harness.kind);
  const converse = driver.converse;
  if (converse === undefined) {
    throw new JigsError(
      `${driver.displayName} cannot hold a conversation; run it on a Claude harness`,
    );
  }
  if (request.messages.length === 0) {
    throw new JigsError("a conversation turn needs at least one message");
  }
  try {
    return await runTurn(request, metadata, observers, seams, converse);
  } catch (error) {
    if (error instanceof JitCheckError) return { jitFailure: error.failures };
    throw error;
  }
}

function runTurn(
  request: TurnRequest,
  metadata: RunMetadata,
  observers: readonly TurnObserver[],
  seams: ExecutionSeams,
  converse: NonNullable<Driver<Harness["kind"]>["converse"]>,
): Promise<TurnResult> {
  const { cwd } = request;
  return withRunCancellation(
    metadata.workflowRunId,
    async (signal) => {
      const prepared = await prepareAgentRun({ harness: request.harness, cwd }, seams, signal);
      const stream = seams.openStepStream();
      let tap: ReturnType<typeof createStreamTap> | undefined;
      const toStream: TurnObserver = (event) => {
        if (event.type === "start" && stream !== undefined) {
          tap = createStreamTap(stream, {
            harness: request.harness.kind,
            cwd,
            resume: event.resume,
          });
        }
        if (event.type === "part") tap?.write(event.part);
      };
      const observe = (event: TurnEvent) => {
        for (const observer of [toStream, ...observers]) {
          try {
            void Promise.resolve(observer(event)).catch(() => {});
          } catch {}
        }
      };
      try {
        const result = await converse(request, {
          metadata,
          deps: seams,
          env: prepared.env,
          signal,
          observe,
        });
        await tap?.end();
        return result;
      } catch (error) {
        await tap?.end(error);
        throw error;
      } finally {
        prepared.release();
      }
    },
    seams.runStatus,
  );
}
