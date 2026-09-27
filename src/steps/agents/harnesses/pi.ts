import { spawn } from "node:child_process";
import type { ExecutorGeneration } from "../drivers/types.ts";
import { resolvePiExecutable } from "./executables.ts";
import { type PiReduceOptions, reducePiJsonl } from "./pi-jsonl.ts";
import { groupReaper, OWN_GROUP } from "./process-group.ts";

export type PiExecutionOptions = PiReduceOptions & {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  /** Names this Pi in stop diagnostics, such as `Pi for run wrun_123`. */
  owner?: string;
  onStdout?: (chunk: string) => void;
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Pi execution was aborted");
}

/**
 * Execute one Pi JSON-mode turn and reduce its event stream.
 *
 * @remarks
 * It settles only after Pi's process group is gone or a bounded stop attempt has ended. An abort
 * settles it with the signal's reason once that attempt ends, even if Pi's stdio never closes.
 */
export function executePi(options: PiExecutionOptions): Promise<ExecutorGeneration> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<ExecutorGeneration>((resolve, reject) => {
    const child = spawn(resolvePiExecutable(options.env), options.args, {
      cwd: options.cwd,
      env: options.env,
      // A private process group lets jigs reap adapter-owned MCP descendants
      // even when Pi itself is killed before the adapter can dispose them.
      detached: OWN_GROUP,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Leader exit and closed stdio do not mean the group is gone, so every
    // path waits on this before settling.
    const reap = groupReaper(child, options.owner ?? "Pi");
    let settled = false;
    const finish = async (outcome: () => ExecutorGeneration) => {
      await reap();
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      try {
        if (signal?.aborted) throw abortReason(signal);
        resolve(outcome());
      } catch (error) {
        reject(error);
      }
    };
    const onAbort = () => {
      void finish(() => {
        throw abortReason(signal as AbortSignal);
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (settled) return;
      stdout += chunk;
      try {
        options.onStdout?.(chunk);
      } catch {
        // Observers cannot change the buffered output or the process result.
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (!settled) stderr += chunk;
    });
    child.once("error", (error) => {
      void finish(() => {
        throw error;
      });
    });
    // `close` waits for inherited stdio handles. Reap the process group as
    // soon as its leader exits so an orphan cannot keep those handles open.
    child.once("exit", () => void reap());
    child.once("close", (code, exitSignal) => {
      void finish(() => {
        try {
          if (exitSignal !== null) throw new Error(`pi terminated by signal ${exitSignal}`);
          if (code === 143) throw new Error("pi was cancelled by SIGTERM (exit code 143)");
          if (code === 129) throw new Error("pi was cancelled by SIGHUP (exit code 129)");
          if (code !== 0) throw new Error(`pi exited with code ${code ?? "unknown"}`);
          return reducePiJsonl(stdout, options);
        } catch (error) {
          throw stderr.trim() === ""
            ? error
            : new Error(
                `${error instanceof Error ? error.message : String(error)}: ${stderr.trim()}`,
              );
        }
      });
    });
  });
}
