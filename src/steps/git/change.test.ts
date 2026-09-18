import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { JigsError } from "../../errors.ts";
import { git } from "../../providers/git.ts";
import {
  MAX_CHANGE_COMMITS,
  MAX_CHANGE_FILES,
  MAX_PATCH_CHARS,
  readChange,
  readPatch,
} from "./change.ts";

const repos: string[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function repo() {
  const dir = await mkdtemp(path.join(tmpdir(), "jigs-change-"));
  repos.push(dir);
  await git(["init", "-b", "main"], dir);
  await git(["config", "user.name", "Test"], dir);
  await git(["config", "user.email", "test@example.com"], dir);
  await git(["config", "commit.gpgsign", "false"], dir);
  await git(["commit", "--allow-empty", "-m", "base"], dir);
  return dir;
}
async function commit(dir: string, subject: string) {
  await git(["add", "-A"], dir);
  await git(["commit", "--allow-empty", "-m", subject], dir);
  return git(["rev-parse", "HEAD"], dir);
}

test("reads resolved commits, all subjects, statuses, binary counts and rename paths", async () => {
  const dir = await repo();
  await writeFile(path.join(dir, "old"), "rename me\n");
  await writeFile(path.join(dir, "delete"), "gone\n");
  await writeFile(path.join(dir, "modify"), "before\n");
  const base = await commit(dir, "start");
  await git(["mv", "old", "new\tname\n "], dir);
  await git(["rm", "delete"], dir);
  await writeFile(path.join(dir, "modify"), "after\nextra\n");
  await writeFile(path.join(dir, "binary"), Buffer.from([0, 1, 2]));
  await commit(dir, "first change");
  await writeFile(path.join(dir, "added"), "added\n");
  const head = await commit(dir, "second change");
  const result = await readChange(dir, "HEAD~2");
  expect(result).toMatchObject({ base, head, truncated: false });
  expect(result.commits.map((c) => c.subject)).toEqual(["second change", "first change"]);
  expect(result.files).toEqual(
    expect.arrayContaining([
      { path: "new\tname\n ", status: "renamed", additions: 0, deletions: 0 },
      { path: "delete", status: "deleted", additions: 0, deletions: 1 },
      { path: "modify", status: "modified", additions: 2, deletions: 1 },
      { path: "binary", status: "added", additions: 0, deletions: 0 },
      { path: "added", status: "added", additions: 1, deletions: 0 },
    ]),
  );
  expect(await readChange(dir, "HEAD")).toEqual({
    base: head,
    head,
    files: [],
    commits: [],
    truncated: false,
  });
});

test("patches stay pinned after HEAD moves, use literal paths, and match diverged endpoint trees", async () => {
  const dir = await repo();
  await git(["checkout", "-b", "base"], dir);
  await writeFile(path.join(dir, "base-only"), "base side\n");
  await commit(dir, "base branch");
  await git(["checkout", "main"], dir);
  await writeFile(path.join(dir, "*.txt"), "selected\n");
  await writeFile(path.join(dir, "other.txt"), "not selected\n");
  await commit(dir, "head branch");
  const summary = await readChange(dir, "base");
  expect(summary.files.find((f) => f.path === "base-only")?.status).toBe("deleted");
  await writeFile(path.join(dir, "*.txt"), "later change\n");
  await commit(dir, "later");
  const result = await readPatch(dir, summary.base, summary.head, ["*.txt", "base-only"]);
  expect(result.truncated).toBe(false);
  expect(result.patches[0]?.text).toContain("+selected");
  expect(result.patches[0]?.text).not.toContain("not selected");
  expect(result.patches[0]?.text).not.toContain("later change");
  expect(result.patches[1]?.text).toContain("-base side");
  await expect(readPatch(dir, summary.base, summary.head, [])).rejects.toBeInstanceOf(JigsError);
});

test("patch budget is shared across files and reports only actual text loss", async () => {
  const dir = await repo();
  const base = await git(["rev-parse", "HEAD"], dir);
  await writeFile(path.join(dir, "one"), `${"a".repeat(MAX_PATCH_CHARS / 2)}\n`);
  await writeFile(path.join(dir, "two"), `${"b".repeat(MAX_PATCH_CHARS / 2)}\n`);
  const head = await commit(dir, "large");
  const result = await readPatch(dir, base, head, ["one", "two"]);
  expect(result.truncated).toBe(true);
  expect(result.patches.reduce((sum, patch) => sum + patch.text.length, 0)).toBe(MAX_PATCH_CHARS);
  expect(await readPatch(dir, head, head, ["one"])).toEqual({
    patches: [{ path: "one", text: "" }],
    truncated: false,
  });
});

test("file and commit caps report truncation only when results are omitted", async () => {
  const dir = await repo();
  const base = await git(["rev-parse", "HEAD"], dir);
  await Promise.all(
    Array.from({ length: MAX_CHANGE_FILES }, (_, i) =>
      writeFile(path.join(dir, `file-${i}`), "x\n"),
    ),
  );
  await commit(dir, "many files");
  expect((await readChange(dir, base)).truncated).toBe(false);
  await writeFile(path.join(dir, "overflow"), "x\n");
  await commit(dir, "overflow");
  const files = await readChange(dir, base);
  expect(files.files).toHaveLength(MAX_CHANGE_FILES);
  expect(files.truncated).toBe(true);
  const tree = await git(["rev-parse", "HEAD^{tree}"], dir);
  const branchBase = await git(["commit-tree", tree, "-m", "other root"], dir);
  let parent = branchBase;
  for (let i = 0; i < MAX_CHANGE_COMMITS; i++)
    parent = await git(["commit-tree", tree, "-p", parent, "-m", `commit ${i}`], dir);
  await git(["update-ref", "HEAD", parent], dir);
  const exact = await readChange(dir, branchBase);
  expect(exact.commits).toHaveLength(MAX_CHANGE_COMMITS);
  expect(exact.truncated).toBe(false);
  parent = await git(["commit-tree", tree, "-p", parent, "-m", "overflow"], dir);
  await git(["update-ref", "HEAD", parent], dir);
  const overflow = await readChange(dir, branchBase);
  expect(overflow.commits).toHaveLength(MAX_CHANGE_COMMITS);
  expect(overflow.truncated).toBe(true);
}, 30_000);
