import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { type BindDeps, bindRepo } from "./bind.ts";

let tmp: string;
let factory: string;
let lines: string[];

beforeEach(() => {
  tmp = makeTmpDir();
  factory = makeFactoryRepo(tmp);
  lines = [];
});
afterEach(() => {
  removeTmpDir(tmp);
});

function deps(overrides: Partial<BindDeps> = {}): BindDeps {
  return {
    cwd: factory,
    out: (line) => lines.push(line),
    ...overrides,
  };
}

const jigsYml = () => readFileSync(path.join(factory, "jigs.yml"), "utf8");
const API = "git@github.com:acme/Api.git";

test("bind writes the remote under a name derived from the repo", async () => {
  const result = await bindRepo(API, deps());
  expect(result).toMatchObject({ name: "api", remote: API });
  expect(jigsYml()).toContain("api:");
  expect(jigsYml()).toContain(`remote: ${API}`);
});

test("a non-github remote's name comes from the last path segment", async () => {
  const result = await bindRepo("git@gitlab.com:acme/Other-Thing.git", deps());
  expect(result.name).toBe("other-thing");
});

test("re-bind is idempotent: no duplicate entries, comments preserved, bytes unchanged", async () => {
  await bindRepo(API, deps());
  const withComment = `# keep me\n${jigsYml()}`;
  writeFileSync(path.join(factory, "jigs.yml"), withComment);

  await bindRepo(API, deps());
  expect(jigsYml()).toBe(withComment);
  expect(lines.some((l) => l.includes("already points at"))).toBe(true);
});

test("a name already bound to another remote is refused, hinting unbind", async () => {
  await bindRepo(API, deps());
  const failure = await bindRepo("git@github.com:acme/api-moved.git", deps(), {
    name: "api",
  }).then(
    () => null,
    (err: unknown) => err,
  );
  expect(String(failure)).toContain("already bound to");
  expect((failure as { hint?: string }).hint).toContain("jigs unbind api");
  expect(jigsYml()).not.toContain("api-moved");
});

test("--name overrides the derived name", async () => {
  const result = await bindRepo(API, deps(), { name: "forge" });
  expect(result.name).toBe("forge");
  expect(jigsYml()).toContain("forge:");
});

test("invalid binding name errors", async () => {
  await expect(bindRepo(API, deps(), { name: "bad name!" })).rejects.toThrow(
    "invalid binding name",
  );
});

test("a path argument is refused with the remote-URL hint", async () => {
  const before = jigsYml();
  for (const arg of ["../some-target-repo", tmp, "~/Code/api"]) {
    await expect(bindRepo(arg, deps())).rejects.toThrow("looks like a path");
  }
  expect(jigsYml()).toBe(before);
});

test("bind outside a factory repo fails with guidance", async () => {
  await expect(bindRepo(API, deps({ cwd: tmp }))).rejects.toThrow(
    "not inside a factory repo",
  );
});

// ---- the webhook leg --------------------------------------------------------

const fetchMock = vi.fn();

function stubWebhookEnv() {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GITHUB_TOKEN", "gh_test_token");
  vi.stubEnv("GITHUB_API_URL", "http://mock.test/github");
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
  fetchMock.mockReset();
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function makeIngressFactory(): void {
  writeFileSync(
    path.join(factory, "jigs.yml"),
    "ingress_url: https://factory.example.ts.net\nservice:\n  port: 8990\n  dashboard_port: 9090\n",
  );
}

test("re-bind with ingress_url configured performs no webhook writes the second time", async () => {
  stubWebhookEnv();
  makeIngressFactory();
  fetchMock
    .mockResolvedValueOnce(new Response("[]"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 9 })));
  const first = await bindRepo(API, deps());
  expect(first.webhook).toBe("created");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const created = JSON.parse(
    String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body),
  );

  const secretFile = path.join(tmp, "data", "jigs", "github-webhook-secret");
  const secretBytes = readFileSync(secretFile);
  expect(created.config.secret).toBe(secretBytes.toString("utf8").trim());

  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify([
        {
          id: 9,
          active: true,
          events: created.events,
          config: {
            url: created.config.url,
            content_type: created.config.content_type,
          },
        },
      ]),
    ),
  );
  const second = await bindRepo(API, deps());
  expect(second.webhook).toBe("verified");
  expect(fetchMock).toHaveBeenCalledTimes(3);
  const [, lastInit] = fetchMock.mock.calls[2] as [string, RequestInit];
  expect(lastInit.method).toBe("GET");
  expect(readFileSync(secretFile)).toEqual(secretBytes);
});

test("bind without ingress_url skips the webhook leg with a note", async () => {
  stubWebhookEnv();
  const result = await bindRepo(API, deps());
  expect(result.webhook).toBe("skipped");
  expect(lines.some((l) => l.includes("no ingress_url"))).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("bind without GITHUB_TOKEN skips the webhook leg with a note", async () => {
  stubWebhookEnv();
  vi.stubEnv("GITHUB_TOKEN", "");
  makeIngressFactory();
  const result = await bindRepo(API, deps());
  expect(result.webhook).toBe("skipped");
  expect(lines.some((l) => l.includes("GITHUB_TOKEN"))).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("bind with a non-github remote skips the webhook leg", async () => {
  stubWebhookEnv();
  makeIngressFactory();
  const result = await bindRepo("git@gitlab.com:acme/api.git", deps());
  expect(result.webhook).toBe("skipped");
  expect(lines.some((l) => l.includes("not a github.com remote"))).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});
