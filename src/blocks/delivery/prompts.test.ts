import { expect, test } from "vitest";
import { defaultReviewPrompt, defaultRevisionPrompt } from "./prompts.ts";

const task = { key: "AGE-1", title: "Repair search", instructions: "Find exact matches" };
const worktree = { path: "/work", branch: "fix", defaultBranch: "main", baseSha: "base" };
const renderDefaultPrompt = async () => "";

test("the review prompt carries the direction a human granted at a limit", () => {
  const rendered = defaultReviewPrompt({
    task,
    worktree,
    attempt: 2,
    baseCommit: "base",
    headCommit: "head",
    diff: "diff",
    instructions: "Check the migration too",
    renderDefaultPrompt,
  });
  expect(rendered).toContain("Check the migration too");
});

test("a review that requested changes without a summary still states the job", async () => {
  const rendered = await defaultRevisionPrompt({
    task,
    worktree,
    attempt: 1,
    threads: [],
    pr: { owner: "owner", repo: "repo", number: 1 },
    instructions: "",
    renderDefaultPrompt,
  });
  expect(rendered).toContain("Address the pull request review threads.");
});
