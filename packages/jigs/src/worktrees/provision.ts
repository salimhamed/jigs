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

function copyOne(src: string, dest: string, overwrite = false): void {
  if (!overwrite && existsSync(dest)) return;
  mkdirSync(path.dirname(dest), { recursive: true });
  // recursive covers the directory match: the whole tree lands at once.
  cpSync(src, dest, { recursive: true });
}

function copyPatterns(
  seedDir: string,
  worktreePath: string,
  patterns: string[],
): void {
  // dot:true is load-bearing — the point of `copy` is .env-class files, and
  // most globbers skip dotfiles by default. expandDirectories:false keeps a
  // directory a single match instead of its flattened contents.
  const matches = globSync(patterns, {
    cwd: seedDir,
    dot: true,
    onlyFiles: false,
    expandDirectories: false,
  });
  for (const match of matches) {
    const relative = match.replace(/\/+$/, "");
    if (relative === "") continue;
    const src = path.join(seedDir, relative);
    copyOne(src, path.join(worktreePath, relative));
  }
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
    // exit, not close: close waits for the stdio pipes, which a hook that
    // backgrounds a long-lived process keeps open long after sh itself is
    // gone — and the spawn timeout no longer applies to that wait.
    child.on("exit", (code, signal) => {
      if (code === 0) return resolve();
      reject(new PostCreateFailedError(command, code, signal, tail(stderr)));
    });
  });
}

async function runPostCreate(
  worktreePath: string,
  commands: string[],
  hookTimeoutMinutes: number,
): Promise<void> {
  if (commands.length === 0) return;
  const env = { ...process.env };
  // A venv activated in the operator's shell would point the hook's tooling
  // at an interpreter outside the worktree.
  delete env.VIRTUAL_ENV;
  // One budget across the whole list, not per command.
  const deadline = Date.now() + hookTimeoutMinutes * 60_000;
  for (const command of commands) {
    await runCommand(command, worktreePath, env, deadline - Date.now());
  }
}

export interface ProvisionWorktreeOptions {
  seedDir: string;
  worktreePath: string;
  config: TargetWorktreeConfig;
}

export async function provisionWorktree(
  options: ProvisionWorktreeOptions,
): Promise<void> {
  const { seedDir, worktreePath, config } = options;
  // A binding with no seed directory copies nothing and still runs its hooks.
  if (existsSync(seedDir)) {
    copyPatterns(seedDir, worktreePath, config.copy);
    // The file self-copies, and overwrites where a `copy:` pattern would not:
    // a seeded .jigs.yml is the config jigs just provisioned with, so leaving
    // the repo's committed copy in place would misdescribe the worktree.
    const selfSource = path.join(seedDir, TARGET_CONFIG_FILE);
    if (existsSync(selfSource)) {
      copyOne(selfSource, path.join(worktreePath, TARGET_CONFIG_FILE), true);
    }
  }
  await runPostCreate(
    worktreePath,
    config.post_create,
    config.hook_timeout_minutes,
  );
}
