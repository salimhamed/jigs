import { expect, test, vi } from "vitest";
import { fetchPrSnapshot } from "../../providers/github.ts";
import { readPullRequestSnapshot } from "./fetch-state.ts";

vi.mock("../../providers/github.ts", () => ({ fetchPrSnapshot: vi.fn() }));
vi.mock("../../providers/github-auth.ts", () => ({
  githubAuthFor: (owner: string) => ({
    bearer: async () => "token",
    bot: async () => ({ login: `${owner}-app[bot]`, id: 1 }),
  }),
}));
vi.mock("../../config/factory-context.ts", () => ({
  currentFactoryContext: () => ({ config: { github: { mergeApproval: "review" } } }),
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

test("a snapshot names the bot of the App the hub issued the owner's token for", async () => {
  vi.mocked(fetchPrSnapshot).mockResolvedValue(facts);
  expect((await readPullRequestSnapshot(pr)).appBot).toBe("acme-app[bot]");
});
