import { beforeEach, expect, test, vi } from "vitest";

const { createComment, getIssueParticipants } = vi.hoisted(() => ({
  createComment: vi.fn(async () => ({
    id: "comment-1",
    createdAt: "2026-08-31T12:00:00.000Z",
  })),
  getIssueParticipants: vi.fn(async () => ({
    creator: { id: "user-1", name: "Salim" },
  })),
}));

vi.mock("../providers/linear.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../providers/linear.ts")>()),
  createComment,
  getIssueParticipants,
}));

const { postNeedsHumanComment } = await import("./needs-human.ts");

beforeEach(() => {
  createComment.mockClear();
  getIssueParticipants.mockClear();
});

test("a findings payload renders as prose with its markdown intact", async () => {
  await postNeedsHumanComment("issue-1", "ticket review needs a human", {
    findings: [
      "**Which source should set the version?**\n    - a) `package.json` (recommended)\n    - b) The release tag\n\n    Evidence: The ticket names both sources.",
      "**Should this apply to prereleases?**",
    ],
  });

  expect(createComment).toHaveBeenCalledWith(
    "issue-1",
    [
      "@[Salim](user-1) ticket review needs a human",
      "",
      "1. **Which source should set the version?**\n    - a) `package.json` (recommended)\n    - b) The release tag\n\n    Evidence: The ticket names both sources.",
      "1. **Should this apply to prereleases?**",
    ].join("\n"),
  );
});

test("an unrecognized payload renders in a fenced fallback", async () => {
  await postNeedsHumanComment("issue-1", "configuration needs a human", {
    repair: "Choose a registry",
  });

  expect(createComment).toHaveBeenCalledWith(
    "issue-1",
    [
      "@[Salim](user-1) configuration needs a human",
      "",
      "```json",
      '{\n  "repair": "Choose a registry"\n}',
      "```",
    ].join("\n"),
  );
});
