import { expect, test } from "vitest";
import {
  type ChangeSummary,
  parseNameStatus,
  parseNumstat,
  renderChangeSummary,
} from "./change.ts";

test("name-status translates A/M/D/R and retains a rename's new path", () => {
  expect(parseNameStatus("D\0gone\0M\0README\0A\0new\0R100\0old\0renamed\0")).toEqual([
    { status: "deleted", path: "gone" },
    { status: "modified", path: "README" },
    { status: "added", path: "new" },
    { status: "renamed", path: "renamed" },
  ]);
  expect(parseNameStatus("")).toEqual([]);
});

test("numstat retains per-file counts, binary zeros and unusual renamed paths", () => {
  expect(parseNumstat("0\t47\ta.md\0-\t-\tlogo.png\0 3\t1\t\0old\0new\tname\n \0")).toEqual([
    { path: "a.md", additions: 0, deletions: 47 },
    { path: "logo.png", additions: 0, deletions: 0 },
    { path: "new\tname\n ", additions: 3, deletions: 1 },
  ]);
  expect(parseNumstat("")).toEqual([]);
});

test("renderer names every commit, tallies file statuses and shows per-file counts", () => {
  const summary: ChangeSummary = {
    base: "base",
    head: "head",
    truncated: false,
    commits: [
      { sha: "one", subject: "remove scaffolding" },
      { sha: "two", subject: "update readme" },
    ],
    files: [
      { path: "old", status: "deleted", additions: 0, deletions: 47 },
      { path: "README", status: "modified", additions: 2, deletions: 1 },
    ],
  };
  const rendered = renderChangeSummary(summary);
  expect(rendered).toContain("**Commit** `remove scaffolding`");
  expect(rendered).toContain("**Commit** `update readme`");
  expect(rendered).toContain("**2 files changed** (1 deleted, 1 modified) · +2 / −48 lines");
  expect(rendered).toContain("modified README (+2 / −1)");
  expect(rendered).not.toContain("Summary truncated");
});

test("renderer caps its display at 60 files and distinguishes incomplete step results", () => {
  const rendered = renderChangeSummary({
    base: "base",
    head: "head",
    commits: [],
    truncated: true,
    files: Array.from({ length: 70 }, (_, i) => ({
      path: `file-${i}`,
      status: "deleted",
      additions: 0,
      deletions: 1,
    })),
  });
  expect(rendered).toContain("**70 files changed** (70 deleted)");
  expect(rendered).toContain("file-59");
  expect(rendered).not.toContain("file-60");
  expect(rendered).toContain("… and 10 more");
  expect(rendered).toContain("Summary truncated");
});
