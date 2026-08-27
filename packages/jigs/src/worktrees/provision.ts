import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { globSync } from "tinyglobby";
import {
  TARGET_CONFIG_FILE,
  type TargetWorktreeConfig,
} from "../config/target-config.ts";

// Provisioning ports .worktreerc.yml semantics (ADR 0007): gitignore-blind
// disk globs that must match dotfiles, a directory match copying its whole
// tree, existing destinations never overwritten, fail-fast post_create.

export class PostCreateFailedError extends Error {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(
    command: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stderr: string,
  ) {
    const how =
      signal !== null ? `killed by ${signal}` : `exited ${exitCode ?? "?"}`;
    super(
      `post_create command failed (${how}): ${command}${stderr === "" ? "" : `\n${stderr}`}`,
    );
    this.name = "PostCreateFailedError";
    this.command = command;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderr = stderr;
  }
}

const STDERR_TAIL_LINES = 20;

function tail(text: string): string {
  return text.trimEnd().split("\n").slice(-STDERR_TAIL_LINES).join("\n");
}

function copyOne(src: string, dest: string): boolean {
  if (existsSync(dest)) return false;
  mkdirSync(path.dirname(dest), { recursive: true });
  // recursive covers the directory match: the whole tree lands at once.
  cpSync(src, dest, { recursive: true });
  return true;
}

export function copyPatterns(
  checkoutRoot: string,
  worktreePath: string,
  patterns: string[],
): string[] {
  // dot:true is load-bearing — the point of `copy` is .env-class files, and
  // most globbers skip dotfiles by default. expandDirectories:false keeps a
  // directory a single match instead of its flattened contents.
  const matches = globSync(patterns, {
    cwd: checkoutRoot,
    dot: true,
    onlyFiles: false,
    expandDirectories: false,
  });
  const copied: string[] = [];
  for (const match of matches) {
    const relative = match.replace(/\/+$/, "");
    if (relative === "") continue;
    const src = path.join(checkoutRoot, relative);
    if (copyOne(src, path.join(worktreePath, relative))) copied.push(relative);
  }
  return copied;
}

async function runCommand(
  command: string,
  worktreePath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // spawn rather than the repo's usual promisify(execFile): only spawn can
    // give the child stdin "ignore", and a hook that reads stdin must see EOF
    // instead of hanging on an open pipe until the timeout.
    const child = spawn("sh", ["-c", command], {
      cwd: worktreePath,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: Math.max(timeoutMs, 1),
    });
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", (err) =>
      reject(new PostCreateFailedError(command, null, null, String(err))),
    );
    child.on("close", (code, signal) => {
      if (code === 0) return resolve();
      reject(new PostCreateFailedError(command, code, signal, tail(stderr)));
    });
  });
}

export async function runPostCreate(
  worktreePath: string,
  commands: string[],
  hookTimeoutMinutes: number,
): Promise<void> {
  if (commands.length === 0) return;
  const env = { ...process.env };
  // A venv activated in the operator's shell would point the hook's tooling
  // at the human checkout's interpreter.
  delete env.VIRTUAL_ENV;
  // One budget across the whole list, not per command.
  const deadline = Date.now() + hookTimeoutMinutes * 60_000;
  for (const command of commands) {
    await runCommand(command, worktreePath, env, deadline - Date.now());
  }
}

export interface ProvisionWorktreeOptions {
  checkoutRoot: string;
  worktreePath: string;
  config: TargetWorktreeConfig;
}

export interface ProvisionResult {
  copied: string[];
}

export async function provisionWorktree(
  options: ProvisionWorktreeOptions,
): Promise<ProvisionResult> {
  const { checkoutRoot, worktreePath, config } = options;
  const copied = copyPatterns(checkoutRoot, worktreePath, config.copy);
  // The file self-copies: it is gitignored in plenty of target repos, and the
  // worktree should describe itself the same way the checkout does.
  const selfSource = path.join(checkoutRoot, TARGET_CONFIG_FILE);
  if (
    existsSync(selfSource) &&
    copyOne(selfSource, path.join(worktreePath, TARGET_CONFIG_FILE))
  ) {
    copied.push(TARGET_CONFIG_FILE);
  }
  await runPostCreate(
    worktreePath,
    config.post_create,
    config.hook_timeout_minutes,
  );
  return { copied };
}
