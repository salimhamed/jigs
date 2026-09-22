import { spawn } from "node:child_process";
import type { ExecutorGeneration } from "../drivers/types.ts";
import { resolvePiExecutable } from "./executables.ts";
import { type PiDelta, reducePiJsonl } from "./pi-jsonl.ts";

export type PiExecutionOptions = {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  onDelta?: (delta: PiDelta) => void;
};

const FORCE_KILL_DELAY_MS = 1_000;

/** Execute one Pi JSON-mode turn and reduce its event stream. */
export function executePi(options: PiExecutionOptions): Promise<ExecutorGeneration> {
  if (options.signal?.aborted)
    return Promise.reject(options.signal.reason ?? new Error("Pi execution was aborted"));
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePiExecutable(options.env), options.args, {
      cwd: options.cwd,
      env: options.env,
      // A private process group lets jigs reap adapter-owned MCP descendants
      // even when Pi itself is killed before the adapter can dispose them.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let forceKillTimer: NodeJS.Timeout | undefined;
    const terminateTree = () => {
      const pid = child.pid;
      if (pid === undefined) return;
      if (process.platform === "win32") {
        child.kill("SIGTERM");
        return;
      }
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        return;
      }
      forceKillTimer ??= setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // The group already exited.
        }
      }, FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
    };
    const onAbort = () => terminateTree();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      terminateTree();
      reject(error);
    });
    // `close` waits for inherited stdio handles. Reap the process group as
    // soon as its leader exits so an orphan cannot keep those handles open.
    child.once("exit", terminateTree);
    child.once("close", (code, signal) => {
      options.signal?.removeEventListener("abort", onAbort);
      terminateTree();
      try {
        if (options.signal?.aborted)
          throw options.signal.reason ?? new Error("Pi execution was aborted");
        if (signal !== null) throw new Error(`pi terminated by signal ${signal}`);
        if (code === 143) throw new Error("pi was cancelled by SIGTERM (exit code 143)");
        if (code === 129) throw new Error("pi was cancelled by SIGHUP (exit code 129)");
        if (code !== 0) throw new Error(`pi exited with code ${code ?? "unknown"}`);
        resolve(reducePiJsonl(stdout, options.onDelta));
      } catch (error) {
        reject(
          stderr.trim() === ""
            ? error
            : new Error(
                `${error instanceof Error ? error.message : String(error)}: ${stderr.trim()}`,
              ),
        );
      }
    });
  });
}
