import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  git,
  makeFactoryRepo,
  makeTargetRepo,
  makeTmpDir,
  removeTmpDir,
} from "../test-fixtures.ts";
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
    home: tmp,
    out: (line) => lines.push(line),
    ...overrides,
  };
}

const jigsYml = () => readFileSync(path.join(factory, "jigs.yml"), "utf8");

test("zero-config bind writes a ~-contracted binding with the pinned remote", async () => {
  const target = makeTargetRepo(tmp, {
    remoteUrl: "git@github.com:acme/target-repo.git",
  });
  const result = await bindRepo(target, deps());
  expect(result).toMatchObject({
    name: "target-repo",
    path: "~/target-repo",
    remote: "git@github.com:acme/target-repo.git",
    scaffolded: false,
  });
  expect(jigsYml()).toContain("target-repo:");
  expect(jigsYml()).toContain("path: ~/target-repo");
  expect(jigsYml()).toContain("remote: git@github.com:acme/target-repo.git");
});

test("re-bind is idempotent: no duplicate entries, comments preserved, bytes unchanged", async () => {
  const target = makeTargetRepo(tmp);
  await bindRepo(target, deps());
  const withComment = `# keep me\n${jigsYml()}`;
  writeFileSync(path.join(factory, "jigs.yml"), withComment);

  await bindRepo(target, deps());
  expect(jigsYml()).toBe(withComment);
});

test("re-bind after a remote change re-pins with a notice", async () => {
  const target = makeTargetRepo(tmp, {
    remoteUrl: "git@github.com:acme/old.git",
  });
  await bindRepo(target, deps());
  git(target, "remote", "set-url", "origin", "git@github.com:acme/new.git");

  await bindRepo(target, deps());
  expect(jigsYml()).toContain("git@github.com:acme/new.git");
  expect(jigsYml()).not.toContain("git@github.com:acme/old.git");
  expect(lines.some((l) => l.includes("remote pin updated"))).toBe(true);
});

test("--name overrides the derived name", async () => {
  const target = makeTargetRepo(tmp);
  const result = await bindRepo(target, deps(), { name: "api" });
  expect(result.name).toBe("api");
  expect(jigsYml()).toContain("api:");
});

test("name collision with a different path errors with a --name hint", async () => {
  const first = makeTargetRepo(tmp, { name: "group-a/repo" });
  const second = makeTargetRepo(tmp, { name: "group-b/repo" });
  await bindRepo(first, deps());
  await expect(bindRepo(second, deps())).rejects.toThrow("already bound to");
});

test("invalid binding name errors", async () => {
  const target = makeTargetRepo(tmp);
  await expect(bindRepo(target, deps(), { name: "bad name!" })).rejects.toThrow(
    "invalid binding name",
  );
});

test("an invalid target never touches jigs.yml", async () => {
  const before = jigsYml();
  await expect(bindRepo(path.join(tmp, "missing"), deps())).rejects.toThrow(
    "not a directory",
  );
  await expect(bindRepo(tmp, deps())).rejects.toThrow("not a git checkout");
  expect(jigsYml()).toBe(before);
});

test("bind outside a factory repo fails with guidance", async () => {
  const target = makeTargetRepo(tmp);
  await expect(bindRepo(target, deps({ cwd: tmp }))).rejects.toThrow(
    "not inside a factory repo",
  );
});

test("scaffold offer writes .jigs.yml only on confirm", async () => {
  const target = makeTargetRepo(tmp, {
    files: { "pnpm-lock.yaml": "", ".env": "SECRET=1" },
  });
  const result = await bindRepo(target, deps({ confirm: async () => true }));
  expect(result.scaffolded).toBe(true);
  const scaffold = readFileSync(path.join(target, ".jigs.yml"), "utf8");
  expect(scaffold).toContain("- .env");
  expect(scaffold).toContain("- pnpm install --frozen-lockfile");
});

test("declining the scaffold writes nothing but keeps the bind", async () => {
  const target = makeTargetRepo(tmp);
  const result = await bindRepo(target, deps({ confirm: async () => false }));
  expect(result.scaffolded).toBe(false);
  expect(existsSync(path.join(target, ".jigs.yml"))).toBe(false);
  expect(jigsYml()).toContain("target-repo:");
});

test("scaffold never overwrites an existing .jigs.yml", async () => {
  const target = makeTargetRepo(tmp, {
    files: { ".jigs.yml": "worktree: {}\n" },
  });
  let asked = false;
  await bindRepo(
    target,
    deps({
      confirm: async () => {
        asked = true;
        return true;
      },
    }),
  );
  expect(asked).toBe(false);
  expect(readFileSync(path.join(target, ".jigs.yml"), "utf8")).toBe(
    "worktree: {}\n",
  );
});

test("non-interactive bind skips the scaffold offer with a note", async () => {
  const target = makeTargetRepo(tmp);
  const result = await bindRepo(target, deps());
  expect(result.scaffolded).toBe(false);
  expect(lines.some((l) => l.includes("non-interactive"))).toBe(true);
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
    "ingress_url: https://factory.example.ts.net\n",
  );
}

test("re-bind with ingress_url configured performs no webhook writes the second time", async () => {
  stubWebhookEnv();
  makeIngressFactory();
  const target = makeTargetRepo(tmp, {
    remoteUrl: "git@github.com:acme/target-repo.git",
  });
  fetchMock
    .mockResolvedValueOnce(new Response("[]"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 9 })));
  const first = await bindRepo(target, deps());
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
  const second = await bindRepo(target, deps());
  expect(second.webhook).toBe("verified");
  expect(fetchMock).toHaveBeenCalledTimes(3);
  const [, lastInit] = fetchMock.mock.calls[2] as [string, RequestInit];
  expect(lastInit.method).toBe("GET");
  expect(readFileSync(secretFile)).toEqual(secretBytes);
});

test("bind without ingress_url skips the webhook leg with a note", async () => {
  stubWebhookEnv();
  const target = makeTargetRepo(tmp);
  const result = await bindRepo(target, deps());
  expect(result.webhook).toBe("skipped");
  expect(lines.some((l) => l.includes("no ingress_url"))).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("bind without GITHUB_TOKEN skips the webhook leg with a note", async () => {
  stubWebhookEnv();
  vi.stubEnv("GITHUB_TOKEN", "");
  makeIngressFactory();
  const target = makeTargetRepo(tmp);
  const result = await bindRepo(target, deps());
  expect(result.webhook).toBe("skipped");
  expect(lines.some((l) => l.includes("GITHUB_TOKEN"))).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("bind with a non-github remote skips the webhook leg", async () => {
  stubWebhookEnv();
  makeIngressFactory();
  const target = makeTargetRepo(tmp, {
    remoteUrl: "git@gitlab.com:acme/target-repo.git",
  });
  const result = await bindRepo(target, deps());
  expect(result.webhook).toBe("skipped");
  expect(lines.some((l) => l.includes("not a github.com remote"))).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});
