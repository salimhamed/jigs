import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
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

function locksDir(): string {
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
  let token = tryAcquire(lockPath);
  while (token === null) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for the lock ${lockPath}`,
      );
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
