import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fetchPrSnapshot } from "./github";

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

test("fetchPrSnapshot shapes the PR and its reviews", async () => {
  fetchMock
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ state: "open", merged: false })),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: 7,
            state: "APPROVED",
            body: null,
            user: { login: "reviewer" },
            submitted_at: "2026-08-26T12:00:00Z",
          },
        ]),
      ),
    );
  const snapshot = await fetchPrSnapshot({
    owner: "acme",
    repo: "api",
    number: 41,
  });
  expect(snapshot).toEqual({
    state: "open",
    merged: false,
    reviews: [
      {
        id: 7,
        state: "APPROVED",
        body: "",
        user: "reviewer",
        submittedAt: "2026-08-26T12:00:00Z",
      },
    ],
  });

  const urls = fetchMock.mock.calls.map(([url]) => url);
  expect(urls[0]).toBe("http://mock.test/github/repos/acme/api/pulls/41");
  expect(urls[1]).toBe(
    "http://mock.test/github/repos/acme/api/pulls/41/reviews?per_page=100",
  );
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(new Headers(init.headers).get("authorization")).toBe(
    "Bearer gh_test_token",
  );
});

test("a non-2xx response throws with the path named", async () => {
  fetchMock.mockResolvedValueOnce(new Response("nope", { status: 404 }));
  await expect(
    fetchPrSnapshot({ owner: "acme", repo: "api", number: 41 }),
  ).rejects.toThrow("/repos/acme/api/pulls/41");
});

test("a missing GITHUB_TOKEN throws before any request", async () => {
  vi.stubEnv("GITHUB_TOKEN", "");
  await expect(
    fetchPrSnapshot({ owner: "acme", repo: "api", number: 41 }),
  ).rejects.toThrow("GITHUB_TOKEN");
  expect(fetchMock).not.toHaveBeenCalled();
});
