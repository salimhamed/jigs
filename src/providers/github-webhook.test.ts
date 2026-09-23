import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetGithubAuth } from "./github-auth.ts";
import {
  ensureRepoWebhook,
  inspectRepoWebhook,
  parseGithubRemote,
  WEBHOOK_EVENTS,
} from "./github-webhook.ts";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GITHUB_API_URL", "http://mock.test/github");
  vi.stubEnv("GITHUB_TOKEN", "gh_test_token");
  resetGithubAuth();
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetGithubAuth();
});

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

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body));

const opts = {
  owner: "acme",
  repo: "api",
  webhooksUrl: "https://factory.example.ts.net",
  secret: "hook-secret",
};

test("creates the webhook when none matches", async () => {
  expect(WEBHOOK_EVENTS).toContain("status");
  fetchMock.mockResolvedValueOnce(jsonResponse([])).mockResolvedValueOnce(jsonResponse({ id: 9 }));
  expect(await ensureRepoWebhook(opts)).toEqual({
    outcome: "created",
    otherHosts: [],
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [listUrl] = fetchMock.mock.calls[0] as [string];
  expect(listUrl).toBe("http://mock.test/github/repos/acme/api/hooks?per_page=100");
  const [createUrl, createInit] = fetchMock.mock.calls[1] as [string, RequestInit];
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

// GitHub never returns the secret, so a hook that looks right may still carry
// a stale one: bind must send the current secret regardless.
test("a matching webhook is verified and still PATCHed with the rotated secret", async () => {
  fetchMock
    .mockResolvedValueOnce(
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
    )
    .mockResolvedValueOnce(jsonResponse({ id: 9 }));
  expect(await ensureRepoWebhook({ ...opts, secret: "rotated-secret" })).toEqual({
    outcome: "verified",
    otherHosts: [],
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [patchUrl, patchInit] = fetchMock.mock.calls[1] as [string, RequestInit];
  expect(patchUrl).toBe("http://mock.test/github/repos/acme/api/hooks/9");
  expect(patchInit.method).toBe("PATCH");
  expect(JSON.parse(String(patchInit.body))).toEqual({
    config: {
      url: "https://factory.example.ts.net/ingress/github",
      content_type: "json",
      secret: "rotated-secret",
    },
    events: WEBHOOK_EVENTS,
    active: true,
  });
});

// The event set is named once, so bind (ensure) and doctor (inspect) cannot
// drift apart over `issue_comment`, the top-level PR comment.
test("a hook missing status is repaired by bind and failed by doctor", async () => {
  const stale = [
    {
      id: 9,
      active: true,
      events: WEBHOOK_EVENTS.filter((event) => event !== "status"),
      config: {
        url: "https://factory.example.ts.net/ingress/github",
        content_type: "json",
      },
    },
  ];
  fetchMock.mockResolvedValueOnce(jsonResponse(stale));
  expect(await inspectRepoWebhook({ ...opts })).toEqual({ state: "missing" });

  fetchMock
    .mockResolvedValueOnce(jsonResponse(stale))
    .mockResolvedValueOnce(jsonResponse({ id: 9 }));
  expect((await ensureRepoWebhook(opts)).outcome).toBe("updated");
  const [, patchInit] = fetchMock.mock.calls[2] as [string, RequestInit];
  expect(JSON.parse(String(patchInit.body)).events).toEqual(WEBHOOK_EVENTS);
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
  expect(await ensureRepoWebhook(opts)).toEqual({
    outcome: "updated",
    otherHosts: [],
  });

  const [patchUrl, patchInit] = fetchMock.mock.calls[1] as [string, RequestInit];
  expect(patchUrl).toBe("http://mock.test/github/repos/acme/api/hooks/9");
  expect(patchInit.method).toBe("PATCH");
  expect(JSON.parse(String(patchInit.body)).events).toEqual(WEBHOOK_EVENTS);
});

test("creates our webhook and leaves another host's jigs hook untouched", async () => {
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
  expect(await ensureRepoWebhook(opts)).toEqual({
    outcome: "created",
    otherHosts: ["old-tunnel.example.ts.net"],
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [createUrl, createInit] = fetchMock.mock.calls[1] as [string, RequestInit];
  expect(createUrl).toBe("http://mock.test/github/repos/acme/api/hooks");
  expect(createInit.method).toBe("POST");
  expect(JSON.parse(String(createInit.body)).config.url).toBe(
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
  expect(await ensureRepoWebhook(opts)).toEqual({
    outcome: "updated",
    otherHosts: [],
  });
});

test("a non-2xx response surfaces as a JigsError naming the path", async () => {
  fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
  await expect(ensureRepoWebhook(opts)).rejects.toThrow("/repos/acme/api/hooks");
});
