import { JigsError } from "../../../errors.ts";
import { withRunCancellation } from "../../../run-cancellation.ts";
import type { TurnRequest, TurnResult } from "../../../workflow/agents/conversation.ts";
import type { RunMetadata } from "../../runtime/run-context.ts";
import { prepareAgentRun } from "./runner.ts";
import { type ExecutionSeams, executionSeams } from "./seams.ts";
import { createStreamTap } from "./step-stream.ts";
import type { TurnEvent, TurnObserver } from "./types.ts";

/**
 * Run one turn of a conversation in a worktree, with the checks, environment, lock and run
 * cancellation of an agent step. While it runs, `liveTurn(request.conversation)` takes more
 * messages and stops it. `observers` see its activity; their failures are ignored.
 */
export function executeTurn(
  request: TurnRequest,
  metadata: RunMetadata,
  observers: readonly TurnObserver[] = [],
): Promise<TurnResult> {
  return executeTurnWith(request, metadata, observers, executionSeams);
}

export async function executeTurnWith(
  request: TurnRequest,
  metadata: RunMetadata,
  observers: readonly TurnObserver[],
  seams: ExecutionSeams,
): Promise<TurnResult> {
  const driver = seams.resolveDriver(request.harness.kind);
  const converse = driver.converse;
  if (converse === undefined) {
    throw new JigsError(
      `${driver.displayName} cannot hold a conversation; run it on a Claude harness`,
    );
  }
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
