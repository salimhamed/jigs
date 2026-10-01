import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GitHubApiError } from "../../providers/github-api.ts";
import { resetGithubAuth } from "../../providers/github-auth.ts";
import { callGitHub } from "./call.ts";

let fetchMock: ReturnType<typeof vi.fn>;
let reply: () => Response;

beforeEach(() => {
  vi.stubEnv("GITHUB_API_URL", "http://github.test");
  vi.stubEnv("GITHUB_TOKEN", "ghp-test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  fetchMock = vi.fn(async () => reply());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  resetGithubAuth();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("any endpoint is called with the factory's token and returns GitHub's JSON", async () => {
  reply = () =>
    Response.json({ number: 7, requested_reviewers: [{ login: "octocat" }] }, { status: 201 });
  const body = await callGitHub<{ number: number }>(
    "POST",
    "/repos/acme/app/pulls/7/requested_reviewers",
    { body: { reviewers: ["octocat"] } },
  );
  expect(body).toEqual({ number: 7, requested_reviewers: [{ login: "octocat" }] });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://github.test/repos/acme/app/pulls/7/requested_reviewers");
  expect(init.method).toBe("POST");
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer ghp-test");
  expect(JSON.parse(String(init.body))).toEqual({ reviewers: ["octocat"] });
});

test("a no-content answer returns undefined", async () => {
  reply = () => new Response(null, { status: 204 });
  await expect(
    callGitHub("DELETE", "/repos/acme/app/issues/7/labels/jigs"),
  ).resolves.toBeUndefined();
});

test("an endpoint outside a repository authenticates for the account it names", async () => {
  reply = () => Response.json([{ slug: "platform" }]);
  await expect(callGitHub("GET", "/orgs/acme/teams")).rejects.toThrow("requires an account");
  await expect(callGitHub("GET", "/orgs/acme/teams", { account: "acme" })).resolves.toEqual([
    { slug: "platform" },
  ]);
});

test("a GitHub error carries the status and GitHub's message", async () => {
  reply = () =>
    Response.json(
      { message: "Reviews may only be requested from collaborators.", documentation_url: "x" },
      { status: 422 },
    );
  const error = await callGitHub("POST", "/repos/acme/app/pulls/7/requested_reviewers", {
    body: { reviewers: ["stranger"] },
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GitHubApiError);
  expect(error).toMatchObject({
    status: 422,
    githubMessage: "Reviews may only be requested from collaborators.",
  });
});
