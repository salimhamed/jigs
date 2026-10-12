import { readFileSync } from "node:fs";
import { beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { githubAuthFor } from "../providers/github-auth.ts";
import type { Factory } from "../workflow/factory.ts";
import { github } from "../workflow/github/source.ts";
import { SOURCES } from "./event-triggers/sources.ts";
import { triggerChecks, triggerInstallations } from "./event-triggers/view.ts";

vi.mock("../providers/github-auth.ts", () => ({ githubAuthFor: vi.fn() }));

const pushes = SOURCES["github.pushes"];
const pullRequests = SOURCES["github.pullRequests"];
if (pushes === undefined || pullRequests === undefined)
  throw new Error("the GitHub sources are not registered");

const BOT = { login: "acme-jigs[bot]", id: 9919 };
const ADA = { login: "ada", id: 583231, type: "User" };
const bot = vi.fn(async () => BOT);

beforeEach(() => {
  bot.mockClear();
  vi.mocked(githubAuthFor).mockReturnValue({
    bearer: async () => "token",
    invalidate: () => {},
    bot,
    account: async () => "Acme",
  });
});

const ACME = { installationName: "acme" };
const BEFORE = "6113728f27ae82c7b1a177c8d03f9e96e0adf246";
const AFTER = "0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c";

// A push to `main` as GitHub's webhooks send it: the factory's App merging a person's pull request.
const push = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL("./fixtures/github-push.json", import.meta.url), "utf8"));

const from = (payload: unknown, { name = "push", installationName = "acme" } = {}) => ({
  installationName,
  name,
  payload,
});

test("params take an installation name, then repositories and branches only", () => {
  const params = (value: unknown) => pushes.params.safeParse(value).success;
  expect(params({ ...ACME, repositories: ["acme/api"], branches: ["main"] })).toBe(true);
  expect(params({ branches: ["main"] })).toBe(false);
  expect(params({ ...ACME, repositories: ["api"] })).toBe(false);
  expect(params({ ...ACME, repositories: [] })).toBe(false);
  expect(params({ ...ACME, branches: [] })).toBe(false);
  expect(params({ ...ACME, tags: ["v1"] })).toBe(false);
});

test("a push to a branch is that branch moving to its new commit, as of when it was pushed", async () => {
  const pushed = await pushes.fromPush(ACME, from(push()));

  expect(pushed).toEqual({
    key: `Acme/api:main:${BEFORE}:${AFTER}`,
    inputs: {
      installationName: "acme",
      owner: "Acme",
      repo: "api",
      branch: "main",
      before: BEFORE,
      after: AFTER,
    },
    at: new Date(1_791_734_322_000),
  });
  expect(pushes.describe(pushed?.inputs ?? {})).toBe("github Acme/api main 0d1a26e");
});

test("a force-push back to a commit the branch held before is a push of its own", async () => {
  const rolledBack = {
    ...push(),
    before: "9f0a8c2d6b1e4f3a7c5d2e8b0a6f4c1d3e7b9a25",
    forced: true,
  };
  const forward = await pushes.fromPush(ACME, from(push()));
  const back = await pushes.fromPush(ACME, from(rolledBack));
  expect(back?.inputs.after).toBe(forward?.inputs.after);
  expect(back?.key).not.toBe(forward?.key);
});

test("any other event, or one from another installation, is not a push", async () => {
  for (const name of ["pull_request", "create", "delete", "status"])
    expect(await pushes.fromPush(ACME, from(push(), { name }))).toBeNull();
  expect(await pushes.fromPush(ACME, from(push(), { installationName: "other" }))).toBeNull();
});

test("a tag push and a branch deletion start nothing", async () => {
  const tag = { ...push(), ref: "refs/tags/v1.2.0" };
  const deletion = { ...push(), after: "0".repeat(40), deleted: true };
  expect(await pushes.fromPush(ACME, from(tag))).toBeNull();
  expect(await pushes.fromPush(ACME, from(deletion))).toBeNull();
});

test("a push is filtered by repository, in any case, and by branch name", async () => {
  const matches = async (params: Record<string, unknown>) =>
    (await pushes.fromPush({ ...ACME, ...params }, from(push()))) !== null;
  expect(await matches({ repositories: ["acme/web", "acme/API"] })).toBe(true);
  expect(await matches({ repositories: ["acme/web"] })).toBe(false);
  expect(await matches({ repositories: ["other/api"] })).toBe(false);
  expect(await matches({ branches: ["main"] })).toBe(true);
  expect(await matches({ branches: ["refs/heads/main"] })).toBe(false);
  expect(await matches({ branches: ["Main"] })).toBe(false);
  expect(await matches({ repositories: ["acme/api"], branches: ["release"] })).toBe(false);
});

test("a push it cannot read is ignored loudly, not retried", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(await pushes.fromPush(ACME, from({ ...push(), repository: null }))).toBeNull();
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("[github] ignored a push it could not read"),
  );
  errors.mockRestore();
});

// A pull request Dependabot opened against `main`, as GitHub's webhooks send it.
const opened = (): Record<string, unknown> & { pull_request: Record<string, unknown> } =>
  JSON.parse(
    readFileSync(new URL("./fixtures/github-pull-request-opened.json", import.meta.url), "utf8"),
  );
const withPullRequest = (pr: Record<string, unknown>, event: Record<string, unknown> = {}) => {
  const payload = opened();
  return { ...payload, ...event, pull_request: { ...payload.pull_request, ...pr } };
};
const pullRequest = (
  payload: unknown,
  options: { name?: string; installationName?: string } = {},
) => from(payload, { name: "pull_request", ...options });

test("pull request params take an installation name, then repositories, authors, labels and base branches only", () => {
  const params = (value: unknown) => pullRequests.params.safeParse(value).success;
  expect(
    params({
      ...ACME,
      repositories: ["acme/api"],
      authors: ["dependabot[bot]"],
      labels: ["dependencies"],
      baseBranches: ["main"],
    }),
  ).toBe(true);
  expect(params({ authors: ["ada"] })).toBe(false);
  for (const list of ["repositories", "authors", "labels", "baseBranches"])
    expect(params({ ...ACME, [list]: [] })).toBe(false);
  expect(params({ ...ACME, actions: ["opened"] })).toBe(false);
});

test("an open pull request is its repository and number, as of its event", async () => {
  const pulled = await pullRequests.fromPush(ACME, pullRequest(opened()));

  expect(pulled).toEqual({
    key: "Acme/api#42",
    inputs: { installationName: "acme", owner: "Acme", repo: "api", number: 42 },
    at: new Date("2026-10-11T09:12:03Z"),
  });
  expect(pullRequests.describe(pulled?.inputs ?? {})).toBe("github Acme/api#42");
});

test("any event that shows the pull request matching is that same pull request", async () => {
  for (const action of ["reopened", "labeled", "ready_for_review", "synchronize", "edited"])
    expect(
      (await pullRequests.fromPush(ACME, pullRequest(withPullRequest({}, { action }))))?.key,
    ).toBe("Acme/api#42");
});

test("another event or installation, or a closed or draft pull request, starts nothing and asks no one", async () => {
  for (const name of ["push", "pull_request_review", "issues", "check_suite"])
    expect(await pullRequests.fromPush(ACME, pullRequest(opened(), { name }))).toBeNull();
  expect(
    await pullRequests.fromPush(ACME, pullRequest(opened(), { installationName: "other" })),
  ).toBeNull();
  const closed = withPullRequest({ state: "closed" }, { action: "closed" });
  expect(await pullRequests.fromPush(ACME, pullRequest(closed))).toBeNull();
  expect(
    await pullRequests.fromPush(ACME, pullRequest(withPullRequest({ draft: true }))),
  ).toBeNull();
  expect(
    await pullRequests.fromPush({ ...ACME, authors: ["ada"] }, pullRequest(opened())),
  ).toBeNull();
  expect(bot).not.toHaveBeenCalled();
});

test("a pull request is filtered by repository, in any case, author, label and base branch", async () => {
  const matches = async (params: Record<string, unknown>) =>
    (await pullRequests.fromPush({ ...ACME, ...params }, pullRequest(opened()))) !== null;
  expect(await matches({ repositories: ["acme/web", "ACME/api"] })).toBe(true);
  expect(await matches({ repositories: ["acme/web"] })).toBe(false);
  expect(await matches({ authors: ["renovate[bot]", "dependabot[bot]"] })).toBe(true);
  expect(await matches({ authors: ["dependabot"] })).toBe(false);
  expect(await matches({ labels: ["javascript"] })).toBe(true);
  expect(await matches({ labels: ["agent"] })).toBe(false);
  expect(await matches({ baseBranches: ["main"] })).toBe(true);
  expect(await matches({ baseBranches: ["release"] })).toBe(false);
});

test("a pull request the factory's App opened starts nothing", async () => {
  const fromApp = withPullRequest({ user: BOT }, { sender: BOT });
  expect(await pullRequests.fromPush(ACME, pullRequest(fromApp))).toBeNull();
  expect(githubAuthFor).toHaveBeenCalledWith("acme");
});

test("a person labeling the App's pull request starts its run", async () => {
  const labeled = withPullRequest(
    { user: BOT, labels: [{ name: "agent" }] },
    { action: "labeled", label: { name: "agent" }, sender: ADA },
  );
  expect(
    (await pullRequests.fromPush({ ...ACME, labels: ["agent"] }, pullRequest(labeled)))?.key,
  ).toBe("Acme/api#42");
});

test("a pull request event it cannot read is ignored loudly, not retried", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const unreadable = withPullRequest({ number: undefined });
  expect(await pullRequests.fromPush(ACME, pullRequest(unreadable))).toBeNull();
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("[github] ignored a pull_request event it could not read"),
  );
  errors.mockRestore();
});

const deploy: Factory = {
  workflows: {
    deploy: {
      workflow: async () => undefined,
      inputs: z.object({
        installationName: z.string(),
        owner: z.string(),
        repo: z.string(),
        branch: z.string(),
        before: z.string(),
        after: z.string(),
      }),
    },
    review: {
      workflow: async () => undefined,
      inputs: z.object({
        installationName: z.string(),
        owner: z.string(),
        repo: z.string(),
        number: z.number(),
      }),
    },
  },
  triggers: {
    "deploy-main": {
      active: true,
      workflow: "deploy",
      source: github.pushes({ installationName: "acme", branches: ["main"] }),
    },
    "review-dependabot": {
      active: true,
      workflow: "review",
      source: github.pullRequests({ installationName: "acme", authors: ["dependabot[bot]"] }),
    },
  },
};

test("the sources are shipped, and their triggers name their GitHub installation for doctor", async () => {
  expect(triggerInstallations(deploy)).toEqual({
    "deploy-main": { provider: "github", installationName: "acme" },
    "review-dependabot": { provider: "github", installationName: "acme" },
  });
  const checks = triggerChecks(deploy);
  for (const name of ["deploy-main", "review-dependabot"])
    expect(await checks.find((check) => check.id === `trigger.${name}`)?.run()).toEqual({
      ok: true,
    });
});
