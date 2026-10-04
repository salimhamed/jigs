import { expect, test } from "vitest";
import { parseGithubRemote } from "./github-remote.ts";

test("parseGithubRemote handles ssh, git@, and https forms and returns null for non-github remotes", () => {
  const expected = { owner: "acme-inc", repo: "api.v2" };
  expect(parseGithubRemote("git@github.com:acme-inc/api.v2.git")).toEqual(expected);
  expect(parseGithubRemote("git@github.com:acme-inc/api.v2")).toEqual(expected);
  expect(parseGithubRemote("ssh://git@github.com/acme-inc/api.v2")).toEqual(expected);
  expect(parseGithubRemote("https://github.com/acme-inc/api.v2.git")).toEqual(expected);
  expect(parseGithubRemote("https://github.com/acme-inc/api.v2")).toEqual(expected);
  expect(parseGithubRemote("git@gitlab.com:acme/api.git")).toBe(null);
  expect(parseGithubRemote("https://example.com/acme/api")).toBe(null);
  expect(parseGithubRemote("/home/user/repos/api")).toBe(null);
});
