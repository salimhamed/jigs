import { expect, test, vi } from "vitest";
import { fetchPrSnapshot } from "../../providers/github.ts";
import { appBotFor } from "../../providers/github-auth.ts";
import { readPullRequestSnapshot } from "./fetch-state.ts";

vi.mock("../../providers/github.ts", () => ({ fetchPrSnapshot: vi.fn() }));
vi.mock("../../providers/github-auth.ts", () => ({
  appBotFor: vi.fn(),
  githubAuthFor: () => ({
    identity: { mode: "app", appId: 7, installationId: 2, privateKeyPath: "k", operator: "me" },
    bearer: async () => "token",
  }),
}));
vi.mock("../../config/factory-root.ts", () => ({ factoryRoot: () => "/factory" }));
vi.mock("../../config/factory-config.ts", () => ({
  readFactoryConfig: () => ({ github: { mergeApproval: "review" } }),
}));

const pr = { owner: "acme", repo: "api", number: 1 };
const facts = {
  state: "open" as const,
  merged: false,
  draft: false,
  headSha: "h1",
  mergeState: "clean",
  labels: [],
  mergeCommitSha: null,
  reviews: [],
  reviewThreads: [],
  conversationComments: [],
  ci: "green" as const,
  failingChecks: [],
};

test("an App snapshot names the App's bot", async () => {
  vi.mocked(fetchPrSnapshot).mockResolvedValue(facts);
  vi.mocked(appBotFor).mockResolvedValue({ login: "jigs-dev[bot]", id: 1 });
  expect((await readPullRequestSnapshot(pr)).appBot).toBe("jigs-dev[bot]");
});

test("a failed bot lookup says it was the App's bot lookup", async () => {
  vi.mocked(fetchPrSnapshot).mockResolvedValue(facts);
  vi.mocked(appBotFor).mockRejectedValue(new Error("GitHub API 401 on /app"));
  await expect(readPullRequestSnapshot(pr)).rejects.toThrow(
    "could not look up the bot account of GitHub App 7: GitHub API 401 on /app",
  );
});
