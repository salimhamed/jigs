import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { bindingRepoDir } from "../../steps/worktree/layout.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import { type BindDeps, bindRepo } from "./bind.ts";
import { unbindRepo } from "./unbind.ts";

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

const jigsConfig = () => readFileSync(path.join(factory, "jigs.config.ts"), "utf8");
const API = "git@github.com:acme/Api.git";

test("bind writes the remote under a name derived from the repo", async () => {
  const result = await bindRepo(API, deps());
  expect(result).toMatchObject({ name: "api", remote: API });
  expect(jigsConfig()).toContain('"api":');
  expect(jigsConfig()).toContain(`remote: "${API}"`);
});

test("a new binding says the restart that clones it", async () => {
  await bindRepo(API, deps());
  expect(lines).toContain("restart the service to clone api: jigs service restart");
});

test("a non-github remote's name comes from the last path segment", async () => {
  const result = await bindRepo("git@gitlab.com:acme/Other-Thing.git", deps());
  expect(result.name).toBe("other-thing");
});

test("re-bind is idempotent: no duplicate entries, comments preserved, bytes unchanged", async () => {
  await bindRepo(API, deps());
  const withComment = `// keep me\n${jigsConfig()}`;
  writeFileSync(path.join(factory, "jigs.config.ts"), withComment);

  lines = [];
  await bindRepo(API, deps());
  expect(jigsConfig()).toBe(withComment);
  expect(lines.some((l) => l.includes("already points at"))).toBe(true);
});

function markCloned(bindingName: string): void {
  const originRefs = path.join(
    bindingRepoDir({ factoryRoot: factory, bindingName }),
    "refs/remotes/origin",
  );
  mkdirSync(originRefs, { recursive: true });
  writeFileSync(path.join(originRefs, "HEAD"), "ref: refs/heads/main\n");
}

test("a binding whose clone is already on disk needs no restart", async () => {
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
  await bindRepo(API, deps());
  markCloned("api");

  lines = [];
  await bindRepo(API, deps());
  expect(lines.some((l) => l.includes("restart the service"))).toBe(false);
});

test("a name re-bound after an unbind says the restart the old clone hides", async () => {
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
  await bindRepo(API, deps());
  markCloned("api");
  unbindRepo("api", deps());

  lines = [];
  await bindRepo("git@github.com:acme/api-moved.git", deps(), { name: "api" });
  expect(lines).toContain("restart the service to clone api: jigs service restart");
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
  expect(jigsConfig()).not.toContain("api-moved");
});

test("--name overrides the derived name", async () => {
  const result = await bindRepo(API, deps(), { name: "forge" });
  expect(result.name).toBe("forge");
  expect(jigsConfig()).toContain('"forge":');
});

test("invalid binding name errors", async () => {
  await expect(bindRepo(API, deps(), { name: "bad name!" })).rejects.toThrow(
    "invalid binding name",
  );
});

test("a path argument is refused with the remote-URL hint", async () => {
  const before = jigsConfig();
  for (const arg of ["../some-target-repo", tmp, "~/Code/api"]) {
    await expect(bindRepo(arg, deps())).rejects.toThrow("looks like a path");
  }
  expect(jigsConfig()).toBe(before);
});

test("a remote starting with a dash is refused before it can become a git option", async () => {
  const before = jigsConfig();
  await expect(bindRepo("--upload-pack=touch /tmp/pwned", deps())).rejects.toThrow(
    "starts with a dash",
  );
  expect(jigsConfig()).toBe(before);
});

test("bind outside a factory repo fails with guidance", async () => {
  await expect(bindRepo(API, deps({ cwd: tmp }))).rejects.toThrow("not inside a factory repo");
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

function bearerOf(call: number): string | null {
  const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return new Headers(init.headers).get("authorization");
}

function makeIngressFactory(): void {
  writeFileSync(
    path.join(factory, "jigs.config.ts"),
    'export default { ingressUrl: "https://factory.example.ts.net", service: { port: 8990, dashboardPort: 9090 }, workflows: {} };',
  );
}

test("re-bind with ingressUrl configured performs no webhook writes the second time", async () => {
  stubWebhookEnv();
  makeIngressFactory();
  fetchMock
    .mockResolvedValueOnce(new Response("[]"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 9 })));
  const first = await bindRepo(API, deps());
  expect(first.webhook).toBe("created");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const created = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body));

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

test("bind names other jigs hook hosts after its result", async () => {
  stubWebhookEnv();
  makeIngressFactory();
  fetchMock
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: 8,
            active: true,
            events: [],
            config: { url: "https://old.example.test/ingress/github" },
          },
          {
            id: 9,
            active: true,
            events: [],
            config: { url: "https://teammate.example.test/ingress/github" },
          },
        ]),
      ),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 10 })));
  await bindRepo(API, deps());
  expect(lines).toContain(
    "other jigs hooks on this repo: old.example.test, teammate.example.test — delete one by hand if it was this factory's before a hostname change",
  );
});

test("bind without ingressUrl skips the webhook leg with a note", async () => {
  stubWebhookEnv();
  const result = await bindRepo(API, deps());
  expect(result.webhook).toBe("skipped");
  expect(lines.some((l) => l.includes("no ingressUrl"))).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("no GITHUB_TOKEN anywhere fails with the repair, and the retry ensures the webhook", async () => {
  stubWebhookEnv();
  vi.stubEnv("GITHUB_TOKEN", "");
  makeIngressFactory();
  const failure = await bindRepo(API, deps()).catch((err: unknown) => err);
  expect(String(failure)).toContain("GITHUB_TOKEN is not set");
  expect((failure as { hint?: string }).hint).toContain("admin:repo_hook");
  expect(fetchMock).not.toHaveBeenCalled();
  // The binding is already recorded, so the retry is the same command again.
  expect(jigsConfig()).toContain(`remote: "${API}"`);

  vi.stubEnv("GITHUB_TOKEN", "gh_test_token");
  lines = [];
  fetchMock
    .mockResolvedValueOnce(new Response("[]"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 9 })));
  const retry = await bindRepo(API, deps());
  expect(retry.webhook).toBe("created");
  // The failed run wrote the binding but nothing cloned it.
  expect(lines).toContain("restart the service to clone api: jigs service restart");
});

test("the repair carries --name, so the retry lands on the same binding", async () => {
  stubWebhookEnv();
  vi.stubEnv("GITHUB_TOKEN", "");
  makeIngressFactory();
  const failure = await bindRepo(API, deps(), { name: "forge" }).catch((err: unknown) => err);
  expect((failure as { hint?: string }).hint).toContain(`re-run: jigs bind ${API} --name forge`);
});

test("a failure GitHub did not lay on the token does not send the operator after one", async () => {
  stubWebhookEnv();
  makeIngressFactory();
  fetchMock.mockRejectedValueOnce(new Error("fetch failed"));
  const failure = await bindRepo(API, deps()).catch((err: unknown) => err);
  expect(String(failure)).toContain("fetch failed");
  const { hint } = failure as { hint?: string };
  expect(hint).not.toContain("GITHUB_TOKEN");
  expect(hint).toContain(`jigs bind ${API}`);
});

test("a token GitHub rejects fails with the repair, and the retry ensures the webhook", async () => {
  stubWebhookEnv();
  makeIngressFactory();
  fetchMock.mockResolvedValueOnce(new Response("Bad credentials", { status: 401 }));
  const failure = await bindRepo(API, deps()).catch((err: unknown) => err);
  expect(String(failure)).toContain("401");
  expect((failure as { hint?: string }).hint).toContain(`re-run: jigs bind ${API}`);
  expect(jigsConfig()).toContain(`remote: "${API}"`);

  fetchMock
    .mockResolvedValueOnce(new Response("[]"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 9 })));
  const retry = await bindRepo(API, deps());
  expect(retry.webhook).toBe("created");
});

test("the webhook token comes from the factory's .env when the shell has none", async () => {
  stubWebhookEnv();
  vi.stubEnv("GITHUB_TOKEN", "");
  makeIngressFactory();
  writeFileSync(path.join(factory, ".env"), "GITHUB_TOKEN=from_dotenv\n");
  fetchMock
    .mockResolvedValueOnce(new Response("[]"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 9 })));
  await bindRepo(API, deps());
  expect(bearerOf(0)).toBe("Bearer from_dotenv");
});

test("an exported GITHUB_TOKEN wins over the factory's .env", async () => {
  stubWebhookEnv();
  makeIngressFactory();
  writeFileSync(path.join(factory, ".env"), "GITHUB_TOKEN=from_dotenv\n");
  fetchMock
    .mockResolvedValueOnce(new Response("[]"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 9 })));
  await bindRepo(API, deps());
  expect(bearerOf(0)).toBe("Bearer gh_test_token");
});

test("a rate-limited 403 does not send the operator after a new token", async () => {
  stubWebhookEnv();
  makeIngressFactory();
  fetchMock.mockResolvedValueOnce(
    new Response("You have exceeded a secondary rate limit", { status: 403 }),
  );
  const failure = await bindRepo(API, deps()).catch((err: unknown) => err);
  const { hint } = failure as { hint?: string };
  expect(hint).not.toContain("GITHUB_TOKEN");
  expect(hint).toContain(`once that clears, re-run: jigs bind ${API}`);
});

test("a 403 on the token's scopes asks for a token that carries them", async () => {
  stubWebhookEnv();
  makeIngressFactory();
  fetchMock.mockResolvedValueOnce(
    new Response("Resource not accessible by personal access token", {
      status: 403,
    }),
  );
  const failure = await bindRepo(API, deps()).catch((err: unknown) => err);
  expect((failure as { hint?: string }).hint).toContain("admin:repo_hook");
});

test("a 404 sends the operator to the remote, not to a new token", async () => {
  stubWebhookEnv();
  makeIngressFactory();
  fetchMock.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
  const failure = await bindRepo(API, deps()).catch((err: unknown) => err);
  const { hint } = failure as { hint?: string };
  expect(hint).not.toContain("admin:repo_hook");
  expect(hint).toContain("check the remote");
  expect(hint).toContain("acme/Api");
});

test("a token this shell alone has is noted, since the service reads .env", async () => {
  stubWebhookEnv();
  makeIngressFactory();
  writeFileSync(path.join(factory, ".env"), "GITHUB_TOKEN=\n");
  fetchMock
    .mockResolvedValueOnce(new Response("[]"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 9 })));
  await bindRepo(API, deps());
  expect(
    lines.some((l) => l.includes("this shell's") && l.includes(path.join(factory, ".env"))),
  ).toBe(true);
});

test("a token the factory's .env carries is not flagged as this shell's", async () => {
  stubWebhookEnv();
  makeIngressFactory();
  writeFileSync(path.join(factory, ".env"), "GITHUB_TOKEN=from_dotenv\n");
  fetchMock
    .mockResolvedValueOnce(new Response("[]"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 9 })));
  await bindRepo(API, deps());
  expect(lines.some((l) => l.includes("this shell's"))).toBe(false);
});

test("bind with a non-github remote skips the webhook leg", async () => {
  stubWebhookEnv();
  makeIngressFactory();
  const result = await bindRepo("git@gitlab.com:acme/api.git", deps());
  expect(result.webhook).toBe("skipped");
  expect(lines.some((l) => l.includes("not a github.com remote"))).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("unsupported bindings fail before modifying files or registering webhooks", async () => {
  const text = `const bindings = {}; export default { service: { dashboardPort: 9090 }, ingressUrl: "https://example.com", bindings };`;
  writeFileSync(path.join(factory, "jigs.config.ts"), text);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(bindRepo(API, deps())).rejects.toThrow("Cannot edit bindings in jigs.config.ts");
  expect(jigsConfig()).toBe(text);
  expect(fetch).not.toHaveBeenCalled();
});
