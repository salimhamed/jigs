import { beforeEach, expect, test, vi } from "vitest";
import type { PrSnapshot } from "../../providers/github.ts";
import { fetchPrSnapshot, fetchPrTitle, squashMergePr } from "../../providers/github.ts";
import { squashMergePullRequest } from "./pr.ts";

vi.mock("../../providers/github.ts", () => ({
  fetchPrSnapshot: vi.fn(),
  fetchPrTitle: vi.fn(),
  squashMergePr: vi.fn(),
}));
const pr = { owner: "owner", repo: "repo", number: 1 };
const snapshot: PrSnapshot = {
  state: "open",
  merged: false,
  headSha: "head",
  ci: "green",
  failingChecks: [],
  reviewThreads: [],
  conversationComments: [],
  reviews: [
    { id: 1, user: "person", state: "APPROVED", submittedAt: "today", body: "", commitSha: "head" },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchPrSnapshot).mockResolvedValue(snapshot);
  vi.mocked(fetchPrTitle).mockResolvedValue("fix: title");
  vi.mocked(squashMergePr).mockResolvedValue({ merged: true, sha: "merged" });
});

test("checks readiness again and sends the approved head to the merge endpoint", async () => {
  expect(await squashMergePullRequest(pr, "head")).toEqual({ merged: true, sha: "merged" });
  expect(squashMergePr).toHaveBeenCalledWith(pr, "fix: title", "head");
});

test("does not merge when the head or readiness changed after the gate wake", async () => {
  expect(await squashMergePullRequest(pr, "old")).toEqual({ merged: false, sha: "head" });
  vi.mocked(fetchPrSnapshot).mockResolvedValue({ ...snapshot, ci: "pending" });
  expect(await squashMergePullRequest(pr, "head")).toEqual({ merged: false, sha: "head" });
  expect(squashMergePr).not.toHaveBeenCalled();
});
