import { expect, test, vi } from "vitest";
import { testFactoryContext } from "../test-fixtures.ts";
import { githubRequest } from "./github-api.ts";
import * as hub from "./hub.ts";
import { fakeGithub } from "./test-fixtures.ts";
import { jsonResponse } from "./test-support.ts";

test("each call uses the token of the installation it names, asked of the hub once per name", async () => {
  const github = fakeGithub();
  try {
    const requests = vi.mocked(hub.hubToken).mock.calls;
    github.reply(jsonResponse({})).reply(jsonResponse({})).reply(jsonResponse({}));
    const context = testFactoryContext();
    await githubRequest("acme", "GET", "/repos/Acme/repo/issues", undefined, context);
    await githubRequest("other", "POST", "/graphql", {}, context);
    await githubRequest("acme", "GET", "/repos/Acme/repo", undefined, context);
    expect(requests.map(([provider, name]) => [provider, name])).toEqual([
      ["github", "acme"],
      ["github", "other"],
    ]);
  } finally {
    vi.restoreAllMocks();
  }
});
