import { existsSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import { withFileLock } from "./lock.ts";

let tmp: string;
let lockPath: string;

beforeEach(() => {
  tmp = makeTmpDir();
  lockPath = path.join(tmp, "locks", "ff.lock");
});
afterEach(() => {
  removeTmpDir(tmp);
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

test("a second acquire waits for the first to release", async () => {
  const events: string[] = [];
  const first = withFileLock(lockPath, async () => {
    events.push("first in");
    await sleep(120);
    events.push("first out");
  });
  await sleep(20);
  const second = withFileLock(
    lockPath,
    async () => {
      events.push("second in");
    },
    { pollMs: 10 },
  );
  await Promise.all([first, second]);
  expect(events).toEqual(["first in", "first out", "second in"]);
});

test("a stale lock older than staleMs is taken over", async () => {
  // The first pass creates the locks directory; then a lock file is planted
  // as a crashed holder would have left it.
  await withFileLock(lockPath, async () => {});
  writeFileSync(lockPath, "9999999\n0\n");
  const old = new Date(Date.now() - 10_000);
  utimesSync(lockPath, old, old);
  await expect(
    withFileLock(lockPath, async () => "ran", {
      staleMs: 1_000,
      pollMs: 5,
      timeoutMs: 2_000,
    }),
  ).resolves.toBe("ran");
});

test("a holder that was taken over as stale does not release its successor", async () => {
  const overrun = withFileLock(lockPath, () => sleep(300));
  await sleep(80);
  await withFileLock(
    lockPath,
    async () => {
      // The overrun holder has now run its release: the successor's lock file
      // is not its to delete.
      await overrun;
      expect(existsSync(lockPath)).toBe(true);
    },
    { staleMs: 50, pollMs: 10, timeoutMs: 2_000 },
  );
  expect(existsSync(lockPath)).toBe(false);
});

test("the lock file is removed even when the body throws", async () => {
  await expect(
    withFileLock(lockPath, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(existsSync(lockPath)).toBe(false);
});
