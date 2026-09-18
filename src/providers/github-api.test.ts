import { expect, test } from "vitest";
import { githubRequest } from "./github-api.ts";

test("repository and GraphQL calls require an account before authentication", async () => {
  for (const apiPath of ["/repos//repo/issues", "/repos/owner", "/graphql"]) {
    await expect(githubRequest("GET", apiPath)).rejects.toThrow("requires an account");
  }
});

test("repository paths and GraphQL select their target accounts", async () => {
  const { vi } = await import("vitest");
  const { makeTmpDir, removeTmpDir } = await import("../test-fixtures.ts");
  const { writeFileSync } = await import("node:fs");
  const { useFactoryRoot, resetGithubAuth } = await import("./github-auth.ts");
  const dir = makeTmpDir();
  writeFileSync(
    `${dir}/jigs.config.ts`,
    `export default { service: { dashboardPort: 9090 }, github: { identity: { mode: "app", appId: 1, privateKeyPath: "absent.pem", operator: "human", installations: { covered: 10 } } } }`,
  );
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  useFactoryRoot(dir);
  try {
    await expect(githubRequest("GET", "/repos/Uncovered/repo/issues")).rejects.toThrow(
      "account Uncovered",
    );
    await expect(githubRequest("POST", "/graphql", {}, "Other")).rejects.toThrow("account Other");
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    resetGithubAuth();
    vi.unstubAllGlobals();
    removeTmpDir(dir);
  }
});
