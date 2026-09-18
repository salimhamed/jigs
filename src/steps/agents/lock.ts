import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { jigsDataDir } from "../../config/paths.ts";

// The worktree advisory lock, hand-rolled on O_EXCL: one dependency-free
// primitive whose stale and retry policy is visible in place. Lock files live
// in the jigs data dir, never inside a worktree.

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
}

// Typed so a caller can tell "someone else holds this" apart from anything the
// locked function itself threw.
export class FileLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for the lock ${lockPath}`);
    this.name = "FileLockTimeoutError";
    this.lockPath = lockPath;
  }
}

function locksDir(): string {
  return path.join(jigsDataDir(), "locks");
}

export function lockPathFor(target: string, kind: string): string {
  const resolved = path.resolve(target);
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return path.join(locksDir(), `${kind}-${path.basename(resolved)}-${hash}.lock`);
}

// The token is what makes the release safe: a holder that overran staleMs has
// already been taken over, and must not delete its successor's lock file.
function tryAcquire(lockPath: string): string | null {
  const token = randomUUID();
  try {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, `${token}\n`);
    closeSync(fd);
    return token;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const staleMs = options.staleMs ?? 120_000;
  const pollMs = options.pollMs ?? 50;
  mkdirSync(path.dirname(lockPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  let token = tryAcquire(lockPath);
  while (token === null) {
    if (Date.now() > deadline) {
      throw new FileLockTimeoutError(lockPath, timeoutMs);
    }
    // A holder that crashed leaves the file behind forever; mtime age is the
    // only evidence available without a liveness protocol.
    let stale = false;
    try {
      stale = Date.now() - statSync(lockPath).mtimeMs > staleMs;
    } catch {
      // released between the failed acquire and the stat — just retry
    }
    if (stale) rmSync(lockPath, { force: true });
    else await sleep(pollMs);
    token = tryAcquire(lockPath);
  }
  try {
    return await fn();
  } finally {
    release(lockPath, token);
  }
}

function release(lockPath: string, token: string): void {
  try {
    if (readFileSync(lockPath, "utf8").trim() !== token) return;
  } catch {
    return;
  }
  rmSync(lockPath, { force: true });
}
