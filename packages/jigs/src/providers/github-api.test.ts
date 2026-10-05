import { expect, test, vi } from "vitest";
import { testFactoryContext } from "../test-fixtures.ts";
import { githubRequest } from "./github-api.ts";
import * as hub from "./hub.ts";
import { fakeGithub } from "./test-fixtures.ts";
import { jsonResponse } from "./test-support.ts";

test("repository and GraphQL calls require an account before authentication", async () => {
  for (const apiPath of ["/repos//repo/issues", "/repos/owner", "/graphql"]) {
    await expect(githubRequest("GET", apiPath)).rejects.toThrow("requires an account");
  }
});

test("repository paths and GraphQL use the token of their target account", async () => {
  const github = fakeGithub();
  try {
    const owners = vi.mocked(hub.fetchGithubToken).mock.calls;
    github.reply(jsonResponse({})).reply(jsonResponse({}));
    await githubRequest("GET", "/repos/Acme/repo/issues", undefined, {
      context: testFactoryContext(),
    });
    await githubRequest(
      "POST",
      "/graphql",
      {},
      { account: "Other", context: testFactoryContext() },
    );
    expect(owners.map(([owner]) => owner)).toEqual(["Acme", "Other"]);
  } finally {
    vi.restoreAllMocks();
  }
});
