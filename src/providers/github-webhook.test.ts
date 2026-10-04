import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetGithubAuth } from "./github-auth.ts";
import { configureGithub } from "./github-http.ts";
import { type FakeGithub, fakeGithub } from "./github-test-support.ts";
import {
  ensureRepoWebhook,
  inspectRepoWebhook,
  parseGithubRemote,
  WEBHOOK_EVENTS,
} from "./github-webhook.ts";
import type { FetchCall } from "./test-support.ts";

let github: FakeGithub;

beforeEach(() => {
  vi.stubEnv("GITHUB_TOKEN", "gh_test_token");
  resetGithubAuth();
  github = fakeGithub();
});
afterEach(() => {
  configureGithub();
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
  github.reply(jsonResponse([])).reply(jsonResponse({ id: 9 }));
  expect(await ensureRepoWebhook(opts)).toEqual({
    outcome: "created",
    otherHosts: [],
  });

  expect(github.calls).toHaveLength(2);
  const listUrl = github.calls[0]?.url.href;
  expect(listUrl).toBe("https://api.github.com/repos/acme/api/hooks?per_page=100");
  const createInit = github.calls[1] as FetchCall;
  const createUrl = createInit.url.href;
  expect(createUrl).toBe("https://api.github.com/repos/acme/api/hooks");
  expect(createInit.method).toBe("POST");
  expect(createInit.json).toEqual({
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
  github
    .reply(
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
    .reply(jsonResponse({ id: 9 }));
  expect(await ensureRepoWebhook({ ...opts, secret: "rotated-secret" })).toEqual({
    outcome: "verified",
    otherHosts: [],
  });
  expect(github.calls).toHaveLength(2);
  const patchInit = github.calls[1] as FetchCall;
  const patchUrl = patchInit.url.href;
  expect(patchUrl).toBe("https://api.github.com/repos/acme/api/hooks/9");
  expect(patchInit.method).toBe("PATCH");
  expect(patchInit.json).toEqual({
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
  github.reply(jsonResponse(stale));
  expect(await inspectRepoWebhook({ ...opts })).toEqual({ state: "missing" });

  github.reply(jsonResponse(stale)).reply(jsonResponse({ id: 9 }));
  expect((await ensureRepoWebhook(opts)).outcome).toBe("updated");
  const patchInit = github.calls[2] as FetchCall;
  expect((patchInit.json as Record<string, unknown>).events).toEqual(WEBHOOK_EVENTS);
});

test("patches a webhook whose events drifted", async () => {
  github
    .reply(
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
    .reply(jsonResponse({ id: 9 }));
  expect(await ensureRepoWebhook(opts)).toEqual({
    outcome: "updated",
    otherHosts: [],
  });

  const patchInit = github.calls[1] as FetchCall;
  const patchUrl = patchInit.url.href;
  expect(patchUrl).toBe("https://api.github.com/repos/acme/api/hooks/9");
  expect(patchInit.method).toBe("PATCH");
  expect((patchInit.json as Record<string, unknown>).events).toEqual(WEBHOOK_EVENTS);
});

test("creates our webhook and leaves another host's jigs hook untouched", async () => {
  github
    .reply(
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
    .reply(jsonResponse({ id: 9 }));
  expect(await ensureRepoWebhook(opts)).toEqual({
    outcome: "created",
    otherHosts: ["old-tunnel.example.ts.net"],
  });

  expect(github.calls).toHaveLength(2);
  const createInit = github.calls[1] as FetchCall;
  const createUrl = createInit.url.href;
  expect(createUrl).toBe("https://api.github.com/repos/acme/api/hooks");
  expect(createInit.method).toBe("POST");
  expect((createInit.json as { config: { url: string } }).config.url).toBe(
    "https://factory.example.ts.net/ingress/github",
  );
});

test("patches a webhook whose content_type drifted from json", async () => {
  github
    .reply(
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
    .reply(jsonResponse({ id: 9 }));
  expect(await ensureRepoWebhook(opts)).toEqual({
    outcome: "updated",
    otherHosts: [],
  });
});

test("a non-2xx response surfaces as a JigsError naming the path", async () => {
  github.reply(new Response("forbidden", { status: 403 }));
  await expect(ensureRepoWebhook(opts)).rejects.toThrow("/repos/acme/api/hooks");
});
