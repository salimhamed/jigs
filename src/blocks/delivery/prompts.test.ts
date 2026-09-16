import { expect, test } from "vitest";
import {
  defaultImplementationPrompt,
  defaultReviewPrompt,
  defaultRevisionPrompt,
} from "./prompts.ts";
import type { ReviewRound } from "./review.ts";

const task = { key: "AGE-1", title: "Repair search", instructions: "Find exact matches" };
const worktree = { path: "/work", branch: "fix", defaultBranch: "main", baseSha: "base" };
const renderDefaultPrompt = async () => "";

const reviewing = {
  task,
  worktree,
  attempt: 2,
  baseCommit: "base",
  headCommit: "head",
  diff: "diff",
  instructions: "",
  responses: [],
  renderDefaultPrompt,
};

test("the review prompt carries the direction a human granted at a limit", () => {
  const rendered = defaultReviewPrompt({ ...reviewing, instructions: "Check the migration too" });
  expect(rendered).toContain("Check the migration too");
});

test("the review prompt asks for a blocking flag and blocks only on a blocking finding", () => {
  const rendered = defaultReviewPrompt(reviewing);
  expect(rendered).toContain("Mark each finding blocking or not");
  expect(rendered).toContain("Return changes-requested only when a blocking finding remains");
});

test("a resumed reviewer is told how the builder answered each finding it raised", () => {
  const rendered = defaultReviewPrompt({
    ...reviewing,
    responses: [
      { finding: "Missing a test for the empty case", changed: true, detail: "Added one" },
      { finding: "Rename the helper", changed: false, detail: "The name matches the caller" },
    ],
  });
  expect(rendered).toContain("Missing a test for the empty case\n  changed: Added one");
  expect(rendered).toContain("Rename the helper\n  not changed: The name matches the caller");
  expect(rendered).not.toContain("Earlier rounds of this review");
});

test("a rebuilt reviewer is given the ledger and told not to re-open what it cleared", () => {
  const ledger: ReviewRound[] = [
    {
      round: 1,
      responses: [],
      verdict: "changes-requested",
      findings: [
        { summary: "The check never fires", blocking: true },
        { summary: "Reorder the doc sentences", blocking: false },
      ],
    },
  ];
  const rendered = defaultReviewPrompt({ ...reviewing, ledger });
  expect(rendered).toContain("Earlier rounds of this review");
  expect(rendered).toContain("Round 1 — changes-requested");
  expect(rendered).toContain("- The check never fires");
  expect(rendered).toContain("- Reorder the doc sentences (non-blocking)");
  expect(rendered).toContain("Do not re-open a finding you cleared unless the code under it");
});

test("the implementation prompt marks which findings block and asks for an answer to each", async () => {
  const rendered = await defaultImplementationPrompt({
    task,
    worktree,
    attempt: 2,
    findings: [
      { summary: "The check never fires", blocking: true },
      { summary: "Reorder the doc sentences", blocking: false },
    ],
    instructions: "",
    renderDefaultPrompt,
  });
  expect(rendered).toContain("- The check never fires");
  expect(rendered).toContain("- Reorder the doc sentences (non-blocking)");
  expect(rendered).toContain("Answer every finding you were given");
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
