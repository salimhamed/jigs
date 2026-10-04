import { expect, test, vi } from "vitest";
import { testFactoryContext } from "../test-fixtures.ts";
import { githubRequest } from "./github-api.ts";
import { fakeGithub } from "./test-fixtures.ts";

test("repository and GraphQL calls require an account before authentication", async () => {
  for (const apiPath of ["/repos//repo/issues", "/repos/owner", "/graphql"]) {
    await expect(githubRequest("GET", apiPath)).rejects.toThrow("requires an account");
  }
});

test("repository paths and GraphQL select their target accounts", async () => {
  const context = testFactoryContext({
    config: {
      github: {
        identities: [
          {
            mode: "app",
            appId: 1,
            privateKeyPath: "absent.pem",
            operator: "human",
            installations: { covered: 10 },
          },
        ],
      },
    },
  });
  const github = fakeGithub();
  try {
    await expect(
      githubRequest("GET", "/repos/Uncovered/repo/issues", undefined, { context }),
    ).rejects.toThrow("account Uncovered");
    await expect(
      githubRequest("POST", "/graphql", {}, { account: "Other", context }),
    ).rejects.toThrow("account Other");
    await expect(githubRequest("GET", "/user", undefined, { context })).rejects.toThrow(
      "/user requires a PAT identity",
    );
    expect(github.calls).toHaveLength(0);
  } finally {
    vi.restoreAllMocks();
  }
});
