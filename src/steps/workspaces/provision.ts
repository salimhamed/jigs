import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { globSync } from "tinyglobby";
import type { Binding } from "../../config/factory-config.ts";
import { JigsError } from "../../errors.ts";

// Provisioning ports .worktreerc.yml semantics: gitignore-blind disk globs
// that must match dotfiles, a directory match copying its whole tree, existing
// destinations never overwritten, fail-fast postCreate. The binding says what
// to copy and run; its own directory in the factory repo, `bindings/<name>/`,
// is the root both ends of a copy are relative to.

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
    const how = signal !== null ? `killed by ${signal}` : `exited ${exitCode ?? "?"}`;
    super(`postCreate command failed (${how}): ${command}${stderr === "" ? "" : `\n${stderr}`}`);
    this.name = "PostCreateFailedError";
    this.command = command;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderr = stderr;
  }
}

export class CopySourceMissingError extends Error {
  readonly bindingName: string;
  readonly entry: string;

  constructor(bindingName: string, entry: string, copyDir: string) {
    super(`binding ${bindingName}: copy entry ${entry} matches nothing under ${copyDir}/`);
    this.name = "CopySourceMissingError";
    this.bindingName = bindingName;
    this.entry = entry;
  }
}

const STDERR_TAIL_LINES = 20;

function tail(text: string): string {
  return text.trimEnd().split("\n").slice(-STDERR_TAIL_LINES).join("\n");
}

function copyOne(src: string, dest: string): void {
  if (existsSync(dest)) return;
  mkdirSync(path.dirname(dest), { recursive: true });
  // recursive covers the directory match: the whole tree lands at once.
  cpSync(src, dest, { recursive: true });
}

function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, candidate);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

// Both ends of a copy are relative paths under their own root, so both are
// checked: a `..` entry would otherwise write anywhere on disk, and an
// absolute one matches nothing and would look like a forgotten file.
function assertInsideCopyDir(
  bindingName: string,
  copyDir: string,
  sourceDir: string,
  worktreePath: string,
  entry: string,
  relative: string,
): void {
  if (
    path.isAbsolute(relative) ||
    !isInside(sourceDir, relative) ||
    !isInside(worktreePath, relative)
  ) {
    throw new JigsError(
      `binding ${bindingName}: copy entry ${entry} must be a relative path inside ${copyDir}/`,
      `copy entries are relative to ${copyDir}/ in the factory repo and land at the same path in the worktree`,
    );
  }
}

// One glob per entry rather than one over the whole list: an entry that
// matches nothing has to be nameable in the error.
function copySources(
  bindingName: string,
  factoryRoot: string,
  worktreePath: string,
  entries: string[],
): void {
  const copyDir = path.join("bindings", bindingName);
  const sourceDir = path.join(factoryRoot, copyDir);
  for (const entry of entries) {
    assertInsideCopyDir(bindingName, copyDir, sourceDir, worktreePath, entry, entry);
    // dot:true is load-bearing — the point of `copy` is .env-class files, and
    // most globbers skip dotfiles by default. expandDirectories:false keeps a
    // directory a single match instead of its flattened contents.
    const matches = globSync([entry], {
      cwd: sourceDir,
      dot: true,
      onlyFiles: false,
      expandDirectories: false,
    });
    const relatives = matches
      .map((match) => match.replace(/\/+$/, ""))
      .filter((relative) => relative !== "");
    // A factory that declared a secret and forgot to put it there must not
    // provision a worktree quietly missing it.
    if (relatives.length === 0) {
      throw new CopySourceMissingError(bindingName, entry, copyDir);
    }
    for (const relative of relatives) {
      assertInsideCopyDir(bindingName, copyDir, sourceDir, worktreePath, entry, relative);
      copyOne(path.join(sourceDir, relative), path.join(worktreePath, relative));
    }
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
    child.on("error", (err) => reject(new PostCreateFailedError(command, null, null, String(err))));
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
  binding: Binding;
  factoryRoot: string;
  worktreePath: string;
}

export async function provisionWorktree(options: ProvisionWorktreeOptions): Promise<void> {
  const { binding, factoryRoot, worktreePath } = options;
  copySources(binding.name, factoryRoot, worktreePath, binding.copy);
  await runPostCreate(worktreePath, binding.postCreate, binding.hookTimeoutMinutes);
}
