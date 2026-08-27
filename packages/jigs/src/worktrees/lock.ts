import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { jigsDataDir } from "../paths.ts";

// The advisory file lock ADR 0007 calls for, hand-rolled on O_EXCL: one
// dependency-free primitive whose stale and retry policy is visible in place.
// Lock files live in the jigs data dir, never inside the human checkout.

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
}

export class LockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for the lock ${lockPath}`);
    this.name = "LockTimeoutError";
  }
}

export function locksDir(): string {
  return path.join(jigsDataDir(), "locks");
}

export function checkoutLockPath(checkoutRoot: string, kind: string): string {
  const resolved = path.resolve(checkoutRoot);
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return path.join(
    locksDir(),
    `${kind}-${path.basename(resolved)}-${hash}.lock`,
  );
}

function tryAcquire(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, `${process.pid}\n${Date.now()}\n`);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  while (!tryAcquire(lockPath)) {
    if (Date.now() > deadline) throw new LockTimeoutError(lockPath, timeoutMs);
    // A holder that crashed leaves the file behind forever; mtime age is the
    // only evidence available without a liveness protocol.
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
        rmSync(lockPath, { force: true });
        continue;
      }
    } catch {
      // released between the failed acquire and the stat — just retry
    }
    await sleep(pollMs);
  }
  try {
    return await fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}
