import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { inTestFactory } from "../test-fixtures.ts";
import { ensureRepoLabel } from "./github-label.ts";
import { type FakeGithub, fakeGithub } from "./test-fixtures.ts";

const label = (name: string) => ({ name, color: "1d76db", description: "Managed by jigs" });

let github: FakeGithub;

beforeEach(() => {
  vi.stubEnv("GITHUB_TOKEN", "gh_test_token");
  github = fakeGithub();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
inTestFactory();

test("an existing repository label is verified without a write", async () => {
  github.reply(new Response(JSON.stringify(label("ship it"))));

  await expect(
    ensureRepoLabel({
      installationName: "acme",
      owner: "acme",
      repo: "api",
      label: label("ship it"),
    }),
  ).resolves.toBe("verified");

  expect(github.calls).toHaveLength(1);
  expect(github.calls[0]?.url.href).toBe("https://api.github.com/repos/acme/api/labels/ship%20it");
  expect(github.calls[0]).toMatchObject({ method: "GET" });
});

test("a missing repository label is created with its name, colour and description", async () => {
  github
    .reply(new Response("not found", { status: 404 }))
    .reply(new Response(JSON.stringify(label("ship-it"))));

  await expect(
    ensureRepoLabel({
      installationName: "acme",
      owner: "acme",
      repo: "api",
      label: label("ship-it"),
    }),
  ).resolves.toBe("created");

  expect(github.calls).toHaveLength(2);
  expect(github.calls[1]?.url.href).toBe("https://api.github.com/repos/acme/api/labels");
  expect(github.calls[1]).toMatchObject({
    method: "POST",
    body: JSON.stringify({
      name: "ship-it",
      color: "1d76db",
      description: "Managed by jigs",
    }),
  });
});

test("an error other than absence is not mistaken for a missing label", async () => {
  github.reply(new Response("forbidden", { status: 403 }));

  await expect(
    ensureRepoLabel({
      installationName: "acme",
      owner: "acme",
      repo: "api",
      label: label("ship-it"),
    }),
  ).rejects.toThrow("403");
  expect(github.calls).toHaveLength(1);
});
