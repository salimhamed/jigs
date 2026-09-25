import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GithubApiError } from "../../providers/github-api.ts";
import { bindingRepoDir } from "../../steps/workspaces/layout.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import { JIGS_LABELS } from "../../workflow/pull-requests/policy.ts";
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
    ensureLabel: async () => "verified",
    ...overrides,
  };
}

const jigsConfig = () => readFileSync(path.join(factory, "jigs.config.ts"), "utf8");
const API = "git@github.com:acme/Api.git";
const writeConfig = (bindings: string, extra = "") =>
  writeFileSync(
    path.join(factory, "jigs.config.ts"),
    `export default { ${extra}service: { port: 8990, dashboardPort: 9090 }, bindings: { ${bindings} }, workflows: {} };`,
  );

test("bind writes the remote under a name derived from the repo", async () => {
  const result = await bindRepo(API, deps());
  expect(result).toMatchObject({ name: "api", remote: API });
  expect(jigsConfig()).toContain("api:");
  expect(jigsConfig()).toContain(`remote: "${API}"`);
});

test("bind reuses an alias whose remote already matches", async () => {
  const remote = "git@github.com:acme/gambit-infrastructure.git";
  writeConfig(`// keep this alias\n gambit: { remote: ${JSON.stringify(remote)} }`);
  const before = jigsConfig();

  const result = await bindRepo(remote, deps());

  expect(result.name).toBe("gambit");
  expect(jigsConfig()).toBe(before);
  expect(jigsConfig()).not.toContain("gambitinfrastructure");
  expect(lines).toContain(`gambit already points at ${remote}`);
});

test("--binding-name creates a separate binding even when another name has the remote", async () => {
  await bindRepo(API, deps(), { name: "gambit" });

  const result = await bindRepo(API, deps(), { name: "forge" });

  expect(result.name).toBe("forge");
  expect(jigsConfig()).toContain("gambit:");
  expect(jigsConfig()).toContain("forge:");
});

test("an invalid --binding-name errors even when another name has the remote", async () => {
  await bindRepo(API, deps(), { name: "gambit" });

  await expect(bindRepo(API, deps(), { name: "bad name!" })).rejects.toThrow(
    "invalid binding name",
  );
});

test("an invalid alias from config is refused", async () => {
  writeConfig(`"bad name!": { remote: ${JSON.stringify(API)} }`);

  await expect(bindRepo(API, deps())).rejects.toThrow("invalid binding name");
});

test("an implicit name uses the first binding when a remote is bound more than once", async () => {
  writeConfig(
    `gambit: { remote: ${JSON.stringify(API)} }, forge: { remote: ${JSON.stringify(API)} }`,
  );

  const result = await bindRepo(API, deps());

  expect(result.name).toBe("gambit");
});

test("re-bind refuses an expression-backed remote before the webhook leg", async () => {
  stubWebhookEnv();
  await bindRepo(API, deps());
  const expressionConfig = `const remote = ${JSON.stringify(API)};\n${jigsConfig()
    .replace(
      "export default {",
      'export default { webhooks: { url: "https://factory.example.ts.net", github: { enabled: true }, linear: { enabled: false } },',
    )
    .replace(`remote: "${API}"`, "remote")}`;
  writeFileSync(path.join(factory, "jigs.config.ts"), expressionConfig);

  await expect(bindRepo(API, deps())).rejects.toThrow("Cannot edit bindings");

  expect(jigsConfig()).toBe(expressionConfig);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a prototype-chain repo name creates an own binding", async () => {
  const remote = "git@github.com:acme/constructor.git";

  const result = await bindRepo(remote, deps());

  expect(result).toMatchObject({ name: "constructor", remote });
  expect(jigsConfig()).toContain("constructor:");
});

test("bind creates a derived-name entry when no binding has the remote", async () => {
  await bindRepo("git@github.com:acme/gambit-infrastructure.git", deps(), {
    name: "gambit",
  });

  const result = await bindRepo(API, deps());

  expect(result.name).toBe("api");
  expect(jigsConfig()).toContain("api:");
  expect(jigsConfig()).toContain(`remote: "${API}"`);
});

test("a new binding says jigs up applies and clones it", async () => {
  await bindRepo(API, deps());
  expect(lines).toContain("run pnpm exec jigs up to apply the config and clone api");
});

test("a non-github remote's name comes from the last path segment", async () => {
  const result = await bindRepo("git@gitlab.com:acme/Other-Thing.git", deps());
  expect(result.name).toBe("other-thing");
});

test("re-bind is idempotent: no duplicate entries, comments preserved, bytes unchanged", async () => {
  writeConfig(`// keep me\n api: { remote: ${JSON.stringify(API)} }`);
  const before = jigsConfig();

  await bindRepo(API, deps());
  expect(jigsConfig()).toBe(before);
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
  writeConfig(`api: { remote: ${JSON.stringify(API)} }`);
  markCloned("api");

  await bindRepo(API, deps());
  expect(lines.some((l) => l.includes("pnpm exec jigs up"))).toBe(false);
});

test("a name re-bound after an unbind says jigs up applies the changed config", async () => {
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
  writeConfig(`api: { remote: ${JSON.stringify(API)} }`);
  markCloned("api");
  unbindRepo("api", deps());

  await bindRepo("git@github.com:acme/api-moved.git", deps(), { name: "api" });
  expect(lines).toContain("run pnpm exec jigs up to apply the config and clone api");
});

test("a name already bound to another remote is refused, hinting unbind", async () => {
  writeConfig(`api: { remote: ${JSON.stringify(API)} }`);
  const failure = await bindRepo("git@github.com:acme/api-moved.git", deps(), {
    name: "api",
  }).then(
    () => null,
    (err: unknown) => err,
  );
  expect(String(failure)).toContain("already bound to");
  expect((failure as { hint?: string }).hint).toContain("pnpm exec jigs unbind api");
  expect(jigsConfig()).not.toContain("api-moved");
});

test("--binding-name overrides the derived name", async () => {
  const result = await bindRepo(API, deps(), { name: "forge" });
  expect(result.name).toBe("forge");
  expect(jigsConfig()).toContain("forge:");
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
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "gh-hook-secret");
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

function makeWebhookFactory(): void {
  writeFileSync(
    path.join(factory, "jigs.config.ts"),
    'export default { webhooks: { url: "https://factory.example.ts.net", github: { enabled: true }, linear: { enabled: false } }, service: { port: 8990, dashboardPort: 9090 }, workflows: {} };',
  );
}

test("re-bind verifies the webhook and re-sends the current secret", async () => {
  stubWebhookEnv();
  makeWebhookFactory();
  fetchMock
    .mockResolvedValueOnce(new Response("[]"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 9 })));
  const first = await bindRepo(API, deps());
  expect(first.webhook).toBe("created");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const created = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body));
  expect(created.config.secret).toBe("gh-hook-secret");

  // Rotated in the factory's .env: GitHub cannot show the old one, so the
  // matching hook is PATCHed with the new one anyway.
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
  writeFileSync(path.join(factory, ".env"), "GITHUB_WEBHOOK_SECRET=rotated\n");

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
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 9 })));
  const lines: string[] = [];
  const second = await bindRepo(API, { ...deps(), out: (line) => lines.push(line) });
  expect(second.webhook).toBe("verified");
  expect(lines).toContain("webhook verified: acme/Api (signing secret re-sent)");
  expect(fetchMock).toHaveBeenCalledTimes(4);
  const [, patchInit] = fetchMock.mock.calls[3] as [string, RequestInit];
  expect(patchInit.method).toBe("PATCH");
  expect(JSON.parse(String(patchInit.body)).config.secret).toBe("rotated");
});

test("bind refuses a webhook without GITHUB_WEBHOOK_SECRET and makes no GitHub call", async () => {
  stubWebhookEnv();
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
  makeWebhookFactory();
  const envFile = path.join(factory, ".env");
  const failure = await bindRepo(API, deps()).then(
    () => null,
    (err: unknown) => err,
  );
  expect(String(failure)).toContain(
    `GITHUB_WEBHOOK_SECRET is not set in ${envFile}, so acme/Api's webhook cannot be signed`,
  );
  expect((failure as { hint?: string }).hint).toBe(
    `generate one with \`openssl rand -hex 32\`, set it as GITHUB_WEBHOOK_SECRET in ${envFile} and restart the service (pnpm exec jigs service restart), then re-run: pnpm exec jigs bind ${API}`,
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

test("bind names other jigs hook hosts after its result", async () => {
  stubWebhookEnv();
  makeWebhookFactory();
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

test("bind without a webhooks section skips the webhook leg and says PR waits poll", async () => {
  stubWebhookEnv();
  const result = await bindRepo(API, deps());
  expect(result.webhook).toBe("skipped");
  expect(lines).toContain(
    "note: skipping webhook (GitHub webhooks are off); pull request waits poll every 300 seconds",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

test("bind with GitHub webhooks off needs neither secret nor token, and names the interval", async () => {
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  writeFileSync(
    path.join(factory, "jigs.config.ts"),
    'export default { webhooks: { url: "https://factory.example.ts.net", github: { enabled: false }, linear: { enabled: true } }, service: { port: 8990, dashboardPort: 9090, pollIntervalSeconds: { github: 60 } }, workflows: {} };',
  );
  const result = await bindRepo(API, deps());
  expect(result.webhook).toBe("skipped");
  expect(lines).toContain(
    "note: skipping webhook (GitHub webhooks are off); pull request waits poll every 60 seconds",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

test("bind ensures every jigs label on every run, whatever the approval", async () => {
  writeFileSync(
    path.join(factory, "jigs.config.ts"),
    'export default { github: { identities: [{ mode: "pat" }], mergeApproval: "label" }, service: { port: 8990, dashboardPort: 9090 }, workflows: {} };',
  );
  const ensureLabel = vi.fn().mockResolvedValueOnce("created").mockResolvedValueOnce("verified");

  await bindRepo(API, deps({ ensureLabel }));
  await bindRepo(API, deps({ ensureLabel }));

  expect(ensureLabel).toHaveBeenCalledTimes(2 * JIGS_LABELS.length);
  expect(ensureLabel).toHaveBeenCalledWith({
    owner: "acme",
    repo: "Api",
    label: expect.objectContaining({ name: "jigs:approved" }),
  });
  expect(lines).toContain("label created: acme/Api#jigs:approved");
  expect(lines).toContain("label verified: acme/Api#jigs:approved");
});

test("a factory approving by review still gets the jigs labels", async () => {
  const ensureLabel = vi.fn().mockResolvedValue("verified");
  writeFileSync(
    path.join(factory, "jigs.config.ts"),
    'export default { github: { identities: [{ mode: "app", appId: 1, installations: { acme: 2 }, privateKeyPath: "key.pem", operator: "me" }] }, service: { port: 8990, dashboardPort: 9090 }, workflows: {} };',
  );

  await bindRepo(API, deps({ ensureLabel }));

  expect(ensureLabel).toHaveBeenCalledTimes(JIGS_LABELS.length);
});

test("a label permission failure preserves the binding after ensuring the webhook", async () => {
  stubWebhookEnv();
  writeFileSync(
    path.join(factory, "jigs.config.ts"),
    'export default { webhooks: { url: "https://factory.example.ts.net", github: { enabled: true }, linear: { enabled: false } }, service: { port: 8990, dashboardPort: 9090 }, workflows: {} };',
  );
  fetchMock
    .mockResolvedValueOnce(new Response("[]"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 9 })));
  const ensureLabel = vi
    .fn()
    .mockRejectedValue(
      new GithubApiError(
        403,
        "/repos/acme/Api/labels",
        "Resource not accessible by personal access token",
      ),
    );

  const failure = await bindRepo(API, deps({ ensureLabel })).catch((err: unknown) => err);

  expect(lines).toContain("webhook created: acme/Api");
  expect(jigsConfig()).toContain(`remote: "${API}"`);
  expect(String(failure)).toContain("jigs:approved label could not be ensured");
  expect((failure as { hint?: string }).hint).toContain("repo (or public_repo");
  expect((failure as { hint?: string }).hint).toContain(`re-run: pnpm exec jigs bind ${API}`);
});

test("no GITHUB_TOKEN anywhere fails with the repair, and the retry ensures the webhook", async () => {
  stubWebhookEnv();
  vi.stubEnv("GITHUB_TOKEN", "");
  makeWebhookFactory();
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
  expect(lines).toContain("run pnpm exec jigs up to apply the config and clone api");
});

test("the repair carries --binding-name, so the retry lands on the same binding", async () => {
  stubWebhookEnv();
  vi.stubEnv("GITHUB_TOKEN", "");
  makeWebhookFactory();
  const failure = await bindRepo(API, deps(), { name: "forge" }).catch((err: unknown) => err);
  expect((failure as { hint?: string }).hint).toContain(
    `re-run: pnpm exec jigs bind ${API} --binding-name forge`,
  );
});

test("an alias match is named in the repair command", async () => {
  stubWebhookEnv();
  vi.stubEnv("GITHUB_TOKEN", "");
  writeConfig(
    `gambit: { remote: ${JSON.stringify(API)} }`,
    'webhooks: { url: "https://factory.example.ts.net", github: { enabled: true }, linear: { enabled: false } }, ',
  );

  const failure = await bindRepo(API, deps()).catch((err: unknown) => err);

  expect((failure as { hint?: string }).hint).toContain(
    `re-run: pnpm exec jigs bind ${API} --binding-name gambit`,
  );
});

test("a failure GitHub did not lay on the token does not send the operator after one", async () => {
  stubWebhookEnv();
  makeWebhookFactory();
  fetchMock.mockRejectedValueOnce(new Error("fetch failed"));
  const failure = await bindRepo(API, deps()).catch((err: unknown) => err);
  expect(String(failure)).toContain("fetch failed");
  const { hint } = failure as { hint?: string };
  expect(hint).not.toContain("GITHUB_TOKEN");
  expect(hint).toContain(`pnpm exec jigs bind ${API}`);
});

test("a token GitHub rejects fails with the repair, and the retry ensures the webhook", async () => {
  stubWebhookEnv();
  makeWebhookFactory();
  fetchMock.mockResolvedValueOnce(new Response("Bad credentials", { status: 401 }));
  const failure = await bindRepo(API, deps()).catch((err: unknown) => err);
  expect(String(failure)).toContain("401");
  expect((failure as { hint?: string }).hint).toContain(`re-run: pnpm exec jigs bind ${API}`);
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
  makeWebhookFactory();
  writeFileSync(path.join(factory, ".env"), "GITHUB_TOKEN=from_dotenv\n");
  fetchMock
    .mockResolvedValueOnce(new Response("[]"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 9 })));
  await bindRepo(API, deps());
  expect(bearerOf(0)).toBe("Bearer from_dotenv");
});

test("an exported GITHUB_TOKEN wins over the factory's .env", async () => {
  stubWebhookEnv();
  makeWebhookFactory();
  writeFileSync(path.join(factory, ".env"), "GITHUB_TOKEN=from_dotenv\n");
  fetchMock
    .mockResolvedValueOnce(new Response("[]"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 9 })));
  await bindRepo(API, deps());
  expect(bearerOf(0)).toBe("Bearer gh_test_token");
});

test("a rate-limited 403 does not send the operator after a new token", async () => {
  stubWebhookEnv();
  makeWebhookFactory();
  fetchMock.mockResolvedValueOnce(
    new Response("You have exceeded a secondary rate limit", { status: 403 }),
  );
  const failure = await bindRepo(API, deps()).catch((err: unknown) => err);
  const { hint } = failure as { hint?: string };
  expect(hint).not.toContain("GITHUB_TOKEN");
  expect(hint).toContain(`once that clears, re-run: pnpm exec jigs bind ${API}`);
});

test("a 403 on the token's scopes asks for a token that carries them", async () => {
  stubWebhookEnv();
  makeWebhookFactory();
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
  makeWebhookFactory();
  fetchMock.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
  const failure = await bindRepo(API, deps()).catch((err: unknown) => err);
  const { hint } = failure as { hint?: string };
  expect(hint).not.toContain("admin:repo_hook");
  expect(hint).toContain("check the remote");
  expect(hint).toContain("acme/Api");
});

test("a token this shell alone has is noted, since the service reads .env", async () => {
  stubWebhookEnv();
  makeWebhookFactory();
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
  makeWebhookFactory();
  writeFileSync(path.join(factory, ".env"), "GITHUB_TOKEN=from_dotenv\n");
  fetchMock
    .mockResolvedValueOnce(new Response("[]"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 9 })));
  await bindRepo(API, deps());
  expect(lines.some((l) => l.includes("this shell's"))).toBe(false);
});

test("bind with a non-github remote skips the webhook leg", async () => {
  stubWebhookEnv();
  makeWebhookFactory();
  const result = await bindRepo("git@gitlab.com:acme/api.git", deps());
  expect(result.webhook).toBe("skipped");
  expect(lines.some((l) => l.includes("not a github.com remote"))).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("unsupported bindings fail before modifying files or registering webhooks", async () => {
  const text = `const bindings = {}; export default { service: { dashboardPort: 9090 }, webhooks: { url: "https://example.com", github: { enabled: true }, linear: { enabled: false } }, bindings };`;
  writeFileSync(path.join(factory, "jigs.config.ts"), text);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(bindRepo(API, deps())).rejects.toThrow("Cannot edit bindings in jigs.config.ts");
  expect(jigsConfig()).toBe(text);
  expect(fetch).not.toHaveBeenCalled();
});

test("bind refuses an uncovered account before editing config or provisioning furniture", async () => {
  writeFileSync(
    path.join(factory, "jigs.config.ts"),
    `export default ${JSON.stringify({
      service: { dashboardPort: 9090 },
      bindings: {},
      github: {
        identities: [
          {
            mode: "app",
            appId: 1,
            privateKeyPath: "key.pem",
            operator: "human",
            installations: { other: 10 },
          },
        ],
      },
    })}`,
  );
  const before = jigsConfig();
  await expect(bindRepo(API, deps())).rejects.toMatchObject({
    message: "no GitHub App installation configured for account acme",
    hint: expect.stringContaining('"acme": <installation-id>'),
  });
  expect(jigsConfig()).toBe(before);
  expect(lines).toEqual([]);
});
