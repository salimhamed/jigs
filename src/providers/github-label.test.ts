import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ensureRepoLabel } from "./github-label.ts";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GITHUB_TOKEN", "gh_test_token");
  vi.stubEnv("GITHUB_API_URL", "http://mock.test/github");
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("an existing repository label is verified without a write", async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ name: "ship it" })));

  await expect(ensureRepoLabel({ owner: "acme", repo: "api", name: "ship it" })).resolves.toBe(
    "verified",
  );

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "http://mock.test/github/repos/acme/api/labels/ship%20it",
  );
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
});

test("a missing repository label is created with its configured name", async () => {
  fetchMock
    .mockResolvedValueOnce(new Response("not found", { status: 404 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ name: "ship-it" })));

  await expect(ensureRepoLabel({ owner: "acme", repo: "api", name: "ship-it" })).resolves.toBe(
    "created",
  );

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]?.[0]).toBe("http://mock.test/github/repos/acme/api/labels");
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
    method: "POST",
    body: JSON.stringify({
      name: "ship-it",
      color: "1d76db",
      description: "Approval signal managed by jigs",
    }),
  });
});

test("an error other than absence is not mistaken for a missing label", async () => {
  fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

  await expect(ensureRepoLabel({ owner: "acme", repo: "api", name: "ship-it" })).rejects.toThrow(
    "403",
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
