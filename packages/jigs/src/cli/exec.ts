import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { JigsError } from "../errors.ts";

// One seam for every child process a verb runs on the operator's behalf, so
// a test can stand in for pnpm, docker, nitro or bootstrap with one function.

export interface ExecOutput {
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd: string;
  env?: Record<string, string>;
  // Hands the operator's terminal to the child, for one that prompts or
  // reports its own progress; nothing is captured.
  stdio?: "inherit";
  // Each line the child prints, as it prints it, for one slow enough to look
  // frozen; the output is still captured for the failure mapping.
  onLine?: (line: string) => void;
}

export type ExecFile = (file: string, args: string[], options: ExecOptions) => Promise<ExecOutput>;

// What a failed exec rejects with: `code` is the exit status, or "ENOENT" when
// the binary itself is missing, and whatever the child printed rides along.
export type ExecError = Error & Partial<ExecOutput> & { code?: number | string };

export const nodeExecFile: ExecFile = async (file, args, options) => {
  if (options.stdio === "inherit") return await inheritedExec(file, args, options);
  if (options.onLine !== undefined) return await streamedExec(file, args, options, options.onLine);
  return await promisify(execFile)(file, args, {
    cwd: options.cwd,
    env: options.env,
    maxBuffer: 64 * 1024 * 1024,
  });
};

function inheritedExec(file: string, args: string[], options: ExecOptions): Promise<ExecOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve({ stdout: "", stderr: "" });
      else {
        const status = code ?? signal ?? "unknown";
        reject(
          Object.assign(new Error(`${file} exited with ${status}`), { code: code ?? undefined }),
        );
      }
    });
  });
}

function streamedExec(
  file: string,
  args: string[],
  options: ExecOptions,
  onLine: (line: string) => void,
): Promise<ExecOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env });
    const output = { stdout: "", stderr: "" };
    const pending = { stdout: "", stderr: "" };
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].setEncoding("utf8");
      child[stream].on("data", (chunk: string) => {
        output[stream] += chunk;
        const lines = (pending[stream] + chunk).split(/\r?\n|\r/);
        pending[stream] = lines.pop() ?? "";
        for (const line of lines) if (line !== "") onLine(line);
      });
    }
    child.once("error", reject);
    child.once("close", (code, signal) => {
      for (const rest of [pending.stdout, pending.stderr]) if (rest !== "") onLine(rest);
      if (code === 0) resolve(output);
      else {
        const status = code ?? signal ?? "unknown";
        reject(
          Object.assign(new Error(`${file} exited with ${status}`), {
            code: code ?? undefined,
            ...output,
          }),
        );
      }
    });
  });
}

export function execOutput(result: Partial<ExecOutput>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

export interface ExecErrors {
  missing: JigsError;
  failed: (err: ExecError) => JigsError;
}

// Runs a child on the operator's behalf and turns its two failure shapes into
// the operator's words: a binary that is not there, and one that ran and
// failed — whose output is echoed first, because the JigsError only names it.
export async function execOrExplain(
  execFile: ExecFile,
  file: string,
  args: string[],
  options: ExecOptions,
  out: (line: string) => void,
  errors: ExecErrors,
): Promise<void> {
  try {
    await execFile(file, args, options);
  } catch (err) {
    const failure = err as ExecError;
    if (failure.code === "ENOENT") throw errors.missing;
    if (options.onLine === undefined) {
      for (const line of execOutput(failure).split("\n")) {
        if (line !== "") out(`  ${line}`);
      }
    }
    throw errors.failed(failure);
  }
}
