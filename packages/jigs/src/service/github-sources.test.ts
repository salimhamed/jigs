import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import type { Factory } from "../workflow/factory.ts";
import { github } from "../workflow/github/source.ts";
import { SOURCES } from "./event-triggers/sources.ts";
import { triggerChecks, triggerInstallations } from "./event-triggers/view.ts";

const pushes = SOURCES["github.pushes"];
if (pushes === undefined) throw new Error("github.pushes is not registered");

const ACME = { installationName: "acme" };
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
    key: `Acme/api:main:${AFTER}`,
    inputs: {
      installationName: "acme",
      owner: "Acme",
      repo: "api",
      ref: "main",
      before: "6113728f27ae82c7b1a177c8d03f9e96e0adf246",
      after: AFTER,
    },
    at: new Date(1_791_734_322_000),
  });
  expect(pushes.describe(pushed?.inputs ?? {})).toBe("github Acme/api main 0d1a26e");
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

const deploy: Factory = {
  workflows: {
    deploy: {
      workflow: async () => undefined,
      inputs: z.object({
        installationName: z.string(),
        owner: z.string(),
        repo: z.string(),
        ref: z.string(),
        before: z.string(),
        after: z.string(),
      }),
    },
  },
  triggers: {
    "deploy-main": {
      active: true,
      workflow: "deploy",
      source: github.pushes({ installationName: "acme", branches: ["main"] }),
    },
  },
};

test("the source is shipped, and its trigger names its GitHub installation for doctor", async () => {
  expect(triggerInstallations(deploy)).toEqual({
    "deploy-main": { provider: "github", installationName: "acme" },
  });
  const [check] = triggerChecks(deploy);
  expect(await check?.run()).toEqual({ ok: true });
});
