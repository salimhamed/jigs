import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ensureRepoWebhook,
  ensureWebhookSecret,
  parseGithubRemote,
  WEBHOOK_EVENTS,
} from "./github-webhook.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

const fetchMock = vi.fn();
let tmp: string;

beforeEach(() => {
  tmp = makeTmpDir();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GITHUB_API_URL", "http://mock.test/github");
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

test("parseGithubRemote handles ssh, git@, and https forms and returns null for non-github remotes", () => {
  const expected = { owner: "acme-inc", repo: "api.v2" };
  expect(parseGithubRemote("git@github.com:acme-inc/api.v2.git")).toEqual(
    expected,
  );
  expect(parseGithubRemote("git@github.com:acme-inc/api.v2")).toEqual(expected);
  expect(parseGithubRemote("ssh://git@github.com/acme-inc/api.v2")).toEqual(
    expected,
  );
  expect(parseGithubRemote("https://github.com/acme-inc/api.v2.git")).toEqual(
    expected,
  );
  expect(parseGithubRemote("https://github.com/acme-inc/api.v2")).toEqual(
    expected,
  );
  expect(parseGithubRemote("git@gitlab.com:acme/api.git")).toBe(null);
  expect(parseGithubRemote("https://example.com/acme/api")).toBe(null);
  expect(parseGithubRemote("/home/user/repos/api")).toBe(null);
});

test("the webhook secret is generated once and stable across calls", () => {
  const first = ensureWebhookSecret(tmp);
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(ensureWebhookSecret(tmp)).toBe(first);
  const file = path.join(tmp, "github-webhook-secret");
  expect(readFileSync(file, "utf8")).toBe(`${first}\n`);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body));

const opts = {
  owner: "acme",
  repo: "api",
  ingressUrl: "https://factory.example.ts.net",
  secret: "hook-secret",
  token: "gh_test_token",
};

test("creates the webhook when none matches", async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse([]))
    .mockResolvedValueOnce(jsonResponse({ id: 9 }));
  expect(await ensureRepoWebhook(opts)).toBe("created");

  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [listUrl] = fetchMock.mock.calls[0] as [string];
  expect(listUrl).toBe(
    "http://mock.test/github/repos/acme/api/hooks?per_page=100",
  );
  const [createUrl, createInit] = fetchMock.mock.calls[1] as [
    string,
    RequestInit,
  ];
  expect(createUrl).toBe("http://mock.test/github/repos/acme/api/hooks");
  expect(createInit.method).toBe("POST");
  expect(JSON.parse(String(createInit.body))).toEqual({
    config: {
      url: "https://factory.example.ts.net/ingress/github",
      content_type: "json",
      secret: "hook-secret",
    },
    events: WEBHOOK_EVENTS,
    active: true,
  });
});

test("verifies an existing matching webhook with zero writes", async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse([
      {
        id: 9,
        active: true,
        events: [...WEBHOOK_EVENTS].reverse(),
        config: {
          url: "https://factory.example.ts.net/ingress/github",
          content_type: "json",
        },
      },
    ]),
  );
  expect(await ensureRepoWebhook(opts)).toBe("verified");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("patches a webhook whose events drifted", async () => {
  fetchMock
    .mockResolvedValueOnce(
      jsonResponse([
        {
          id: 9,
          active: true,
          events: ["pull_request"],
          config: {
            url: "https://factory.example.ts.net/ingress/github",
            content_type: "json",
          },
        },
      ]),
    )
    .mockResolvedValueOnce(jsonResponse({ id: 9 }));
  expect(await ensureRepoWebhook(opts)).toBe("updated");

  const [patchUrl, patchInit] = fetchMock.mock.calls[1] as [
    string,
    RequestInit,
  ];
  expect(patchUrl).toBe("http://mock.test/github/repos/acme/api/hooks/9");
  expect(patchInit.method).toBe("PATCH");
  expect(JSON.parse(String(patchInit.body)).events).toEqual(WEBHOOK_EVENTS);
});

test("patches a webhook whose ingress hostname changed instead of creating a second one", async () => {
  fetchMock
    .mockResolvedValueOnce(
      jsonResponse([
        {
          id: 9,
          active: true,
          events: WEBHOOK_EVENTS,
          config: {
            url: "https://old-tunnel.example.ts.net/ingress/github",
            content_type: "json",
          },
        },
      ]),
    )
    .mockResolvedValueOnce(jsonResponse({ id: 9 }));
  expect(await ensureRepoWebhook(opts)).toBe("updated");

  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [patchUrl, patchInit] = fetchMock.mock.calls[1] as [
    string,
    RequestInit,
  ];
  expect(patchUrl).toBe("http://mock.test/github/repos/acme/api/hooks/9");
  expect(patchInit.method).toBe("PATCH");
  expect(JSON.parse(String(patchInit.body)).config.url).toBe(
    "https://factory.example.ts.net/ingress/github",
  );
});

test("patches a webhook whose content_type drifted from json", async () => {
  fetchMock
    .mockResolvedValueOnce(
      jsonResponse([
        {
          id: 9,
          active: true,
          events: WEBHOOK_EVENTS,
          config: {
            url: "https://factory.example.ts.net/ingress/github",
            content_type: "form",
          },
        },
      ]),
    )
    .mockResolvedValueOnce(jsonResponse({ id: 9 }));
  expect(await ensureRepoWebhook(opts)).toBe("updated");
});

test("a non-2xx response surfaces as a JigsError naming the path", async () => {
  fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
  await expect(ensureRepoWebhook(opts)).rejects.toThrow(
    "/repos/acme/api/hooks",
  );
});
