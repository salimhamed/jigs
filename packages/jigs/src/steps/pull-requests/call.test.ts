import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GitHubApiError } from "../../providers/github-http.ts";
import { useGithubClient } from "../../providers/test-fixtures.ts";
import { type FetchCall, fakeFetch } from "../../providers/test-support.ts";
import { removeTmpDir, useTestFactory } from "../../test-fixtures.ts";
import { callGitHub } from "./call.ts";

let calls: FetchCall[];
let reply: () => Response;
let factory: string;

beforeEach(() => {
  factory = useTestFactory();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const fake = fakeFetch(() => reply());
  calls = fake.calls;
  useGithubClient({ fetch: fake.fetch });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeTmpDir(factory);
});

test("any endpoint is called with the factory's token and returns GitHub's JSON", async () => {
  reply = () =>
    Response.json({ number: 7, requested_reviewers: [{ login: "octocat" }] }, { status: 201 });
  const body = await callGitHub<{ number: number }>(
    "POST",
    "/repos/acme/app/pulls/7/requested_reviewers",
    { installationName: "github-acme", body: { reviewers: ["octocat"] } },
  );
  expect(body).toEqual({ number: 7, requested_reviewers: [{ login: "octocat" }] });
  const call = calls[0] as FetchCall;
  expect(call.url.href).toBe("https://api.github.com/repos/acme/app/pulls/7/requested_reviewers");
  expect(call.method).toBe("POST");
  expect(call.headers.authorization).toBe("Bearer ghs_test");
  expect(call.json).toEqual({ reviewers: ["octocat"] });
});

test("a no-content answer returns undefined", async () => {
  reply = () => new Response(null, { status: 204 });
  await expect(
    callGitHub("DELETE", "/repos/acme/app/issues/7/labels/jigs", {
      installationName: "github-acme",
    }),
  ).resolves.toBeUndefined();
});

test("an endpoint outside a repository uses the installation it names", async () => {
  reply = () => Response.json([{ slug: "platform" }]);
  await expect(
    callGitHub("GET", "/orgs/acme/teams", { installationName: "github-acme" }),
  ).resolves.toEqual([{ slug: "platform" }]);
});

test("a GitHub error carries the status and GitHub's message", async () => {
  reply = () =>
    Response.json(
      { message: "Reviews may only be requested from collaborators.", documentation_url: "x" },
      { status: 422 },
    );
  const error = await callGitHub("POST", "/repos/acme/app/pulls/7/requested_reviewers", {
    installationName: "github-acme",
    body: { reviewers: ["stranger"] },
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GitHubApiError);
  expect(error).toMatchObject({
    status: 422,
    githubMessage: "Reviews may only be requested from collaborators.",
  });
});

test("a path without a leading slash is refused before any request", async () => {
  await expect(
    callGitHub("GET", "repos/acme/app/pulls", { installationName: "github-acme" }),
  ).rejects.toThrow("GitHub path repos/acme/app/pulls must start with /");
  expect(calls).toHaveLength(0);
});
