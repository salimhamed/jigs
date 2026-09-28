import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import { readPullRequestTemplate } from "./template.ts";

let dir: string;
const worktree = () => ({
  binding: "app",
  path: dir,
  branch: "b",
  defaultBranch: "main",
  baseSha: "base",
});
const write = (file: string, content: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
};

beforeEach(() => {
  dir = makeTmpDir();
});
afterEach(() => removeTmpDir(dir));

test("a repository without a template has none", async () => {
  expect(await readPullRequestTemplate(worktree())).toBeUndefined();
});

test.each([
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "docs/Pull_Request_Template.md",
])("finds %s", async (file) => {
  write(file, "## Summary\n\n## Testing\n");
  expect(await readPullRequestTemplate(worktree())).toBe("## Summary\n\n## Testing");
});

test(".github wins over the root and docs, as on GitHub", async () => {
  write("docs/pull_request_template.md", "docs");
  write("pull_request_template.md", "root");
  write(".github/pull_request_template.md", "github");
  expect(await readPullRequestTemplate(worktree())).toBe("github");
});

test("an empty template counts as none", async () => {
  write(".github/pull_request_template.md", "\n  \n");
  expect(await readPullRequestTemplate(worktree())).toBeUndefined();
});
