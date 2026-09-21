import { spawn } from "node:child_process";
import type { ExecutorGeneration } from "../drivers/types.ts";
import { resolvePiExecutable } from "./executables.ts";
import { type PiDelta, reducePiJsonl } from "./pi-jsonl.ts";

export type PiExecutionOptions = {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  onDelta?: (delta: PiDelta) => void;
};

/** Execute one Pi JSON-mode turn and reduce its event stream. */
export function executePi(options: PiExecutionOptions): Promise<ExecutorGeneration> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePiExecutable(options.env), options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", () => {
      try {
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
