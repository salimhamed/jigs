import { writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { useFactoryRoot } from "./credentials.ts";
import { githubRequest } from "./github-api.ts";
import { resetGithubAuth } from "./github-auth.ts";
import { configureGithub } from "./github-http.ts";
import { fakeGithub } from "./github-test-support.ts";

test("repository and GraphQL calls require an account before authentication", async () => {
  for (const apiPath of ["/repos//repo/issues", "/repos/owner", "/graphql"]) {
    await expect(githubRequest("GET", apiPath)).rejects.toThrow("requires an account");
  }
});

test("repository paths and GraphQL select their target accounts", async () => {
  const dir = makeTmpDir();
  writeFileSync(
    `${dir}/jigs.config.ts`,
    `export default { service: { dashboardPort: 9090 }, github: { identities: [{ mode: "app", appId: 1, privateKeyPath: "absent.pem", operator: "human", installations: { covered: 10 } }] } }`,
  );
  const github = fakeGithub();
  useFactoryRoot(dir);
  try {
    await expect(githubRequest("GET", "/repos/Uncovered/repo/issues")).rejects.toThrow(
      "account Uncovered",
    );
    await expect(githubRequest("POST", "/graphql", {}, "Other")).rejects.toThrow("account Other");
    await expect(githubRequest("GET", "/user")).rejects.toThrow("/user requires a PAT identity");
    expect(github.calls).toHaveLength(0);
  } finally {
    resetGithubAuth();
    configureGithub();
    removeTmpDir(dir);
  }
});
