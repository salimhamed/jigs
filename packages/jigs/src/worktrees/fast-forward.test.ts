import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  commitToRemote,
  git,
  makeRemoteBackedRepo,
  makeTmpDir,
  removeTmpDir,
} from "../test-fixtures.ts";
import { fastForwardDefaultBranch } from "./fast-forward.ts";

let tmp: string;
let remoteDir: string;
let checkout: string;
let lockPath: string;

beforeEach(() => {
  tmp = makeTmpDir();
  ({ remoteDir, checkout } = makeRemoteBackedRepo(tmp));
  lockPath = path.join(tmp, "locks", "ff.lock");
});
afterEach(() => {
  removeTmpDir(tmp);
});

const ff = (enabled?: boolean) =>
  fastForwardDefaultBranch({
    checkoutRoot: checkout,
    lockPath,
    ...(enabled === undefined ? {} : { enabled }),
  });

const localMain = () => git(checkout, "rev-parse", "refs/heads/main");

test("a clean checkout on the default branch fast-forwards", async () => {
  const advanced = commitToRemote(tmp, remoteDir, "main", { "new.txt": "x\n" });
  const result = await ff();
  expect(result.moved).toBe(true);
  expect(result.to).toBe(advanced);
  expect(localMain()).toBe(advanced);
});

test("a clean checkout on another branch moves the default ref without checking it out", async () => {
  git(checkout, "checkout", "-q", "-b", "feat");
  const advanced = commitToRemote(tmp, remoteDir, "main", { "new.txt": "x\n" });
  const result = await ff();
  expect(result.moved).toBe(true);
  expect(localMain()).toBe(advanced);
  expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat");
});

test("a dirty checkout is skipped, never errored", async () => {
  commitToRemote(tmp, remoteDir, "main", { "new.txt": "x\n" });
  writeFileSync(path.join(checkout, "README.md"), "# edited by a human\n");
  const before = localMain();
  const result = await ff();
  expect(result.skipped).toBe("dirty");
  expect(result.moved).toBe(false);
  expect(localMain()).toBe(before);
});

test("a diverged local default is skipped as not-fast-forward", async () => {
  writeFileSync(path.join(checkout, "local.txt"), "local\n");
  git(checkout, "add", "local.txt");
  git(checkout, "commit", "-q", "-m", "local only");
  commitToRemote(tmp, remoteDir, "main", { "remote.txt": "remote\n" });
  const before = localMain();
  const result = await ff();
  expect(result.skipped).toBe("not-fast-forward");
  expect(localMain()).toBe(before);
});

test("ff_default_branch: false opts out", async () => {
  commitToRemote(tmp, remoteDir, "main", { "new.txt": "x\n" });
  const before = localMain();
  const result = await ff(false);
  expect(result.skipped).toBe("disabled");
  expect(localMain()).toBe(before);
  expect(existsSync(lockPath)).toBe(false);
});

test("an up-to-date default reports already-current", async () => {
  expect((await ff()).skipped).toBe("already-current");
});

test("a git failure surfaces as a skip, never a rejection", async () => {
  const result = await fastForwardDefaultBranch({
    checkoutRoot: path.join(tmp, "not-a-repo"),
    lockPath,
  });
  expect(result.moved).toBe(false);
  expect(result.skipped).toMatch(/error|no-default-branch/);
});

test("concurrent fast-forwards serialize on the advisory lock", async () => {
  const advanced = commitToRemote(tmp, remoteDir, "main", { "new.txt": "x\n" });
  const results = await Promise.all([ff(), ff()]);
  expect(results.filter((r) => r.moved)).toHaveLength(1);
  expect(results.filter((r) => r.skipped === "already-current")).toHaveLength(
    1,
  );
  expect(localMain()).toBe(advanced);
  expect(existsSync(lockPath)).toBe(false);
});
