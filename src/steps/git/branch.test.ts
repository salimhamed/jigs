import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { pushCommit } from "../../providers/git.ts";
import { git, makeRemoteBackedRepo, makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import { pushApprovedChange } from "./branch.ts";

let tmp: string;
let checkout: string;
let remoteDir: string;
let approved: string;
beforeEach(() => {
  tmp = makeTmpDir();
  ({ checkout, remoteDir } = makeRemoteBackedRepo(tmp));
  git(checkout, "checkout", "-qb", "feature");
  git(checkout, "commit", "--allow-empty", "-qm", "approved work");
  approved = git(checkout, "rev-parse", "HEAD");
});
afterEach(() => removeTmpDir(tmp));

test("publishes the approved commit and accepts a retry after a successful push", async () => {
  await expect(pushApprovedChange(checkout, "feature", approved)).resolves.toEqual({
    headSha: approved,
  });
  await pushApprovedChange(checkout, "feature", approved);
  expect(git(remoteDir, "rev-parse", "refs/heads/feature")).toBe(approved);
});

test("rechecks approval after a failed push instead of publishing a later commit", async () => {
  git(checkout, "remote", "set-url", "origin", path.join(tmp, "missing.git"));
  await expect(pushApprovedChange(checkout, "feature", approved)).rejects.toThrow();
  git(checkout, "remote", "set-url", "origin", remoteDir);
  git(checkout, "commit", "--allow-empty", "-qm", "unreviewed work");
  await expect(pushApprovedChange(checkout, "feature", approved)).rejects.toThrow(
    "is not the approved commit",
  );
  expect(git(remoteDir, "for-each-ref", "refs/heads/feature")).toBe("");
});

test("rejects uncommitted work on every attempt", async () => {
  writeFileSync(path.join(checkout, "unreviewed.txt"), "unreviewed");
  await expect(pushApprovedChange(checkout, "feature", approved)).rejects.toThrow(
    "uncommitted changes",
  );
  expect(git(remoteDir, "for-each-ref", "refs/heads/feature")).toBe("");
});

test("the push uses an explicit commit even when HEAD has moved", async () => {
  git(checkout, "commit", "--allow-empty", "-qm", "later work");
  await pushCommit(checkout, "feature", approved);
  expect(git(remoteDir, "rev-parse", "refs/heads/feature")).toBe(approved);
  expect(git(checkout, "rev-parse", "HEAD")).not.toBe(approved);
});
