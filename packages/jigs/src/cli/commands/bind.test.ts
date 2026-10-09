import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GitHubApiError } from "../../providers/github-http.ts";
import { JIGS_LABELS } from "../../providers/github-label.ts";
import { cloneRepoDir } from "../../steps/workspaces/layout.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import { layoutProblems } from "../output-layout.ts";
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
    `export default { ${extra}hub: { url: "https://hub.example.test" }, service: { port: 8990, dashboardPort: 9090 }, bindings: { ${bindings} }, workflows: {} };`,
  );

test("bind writes the remote under a name derived from the repo", async () => {
  const result = await bindRepo(API, deps(), { installation: "gh" });
  expect(result).toMatchObject({ name: "api", remote: API, installationName: "gh" });
  expect(jigsConfig()).toContain("api:");
  expect(jigsConfig()).toContain(`remote: "${API}"`);
  expect(jigsConfig()).toContain(`installationName: "gh"`);
});

test("a new binding without --installation is refused before anything is written", async () => {
  const before = jigsConfig();
  const ensureLabel = vi.fn();
  await expect(bindRepo(API, deps({ ensureLabel }))).rejects.toMatchObject({
    message: expect.stringContaining("bind needs the GitHub installation"),
    hint: expect.stringContaining("--installation <installation-name>"),
  });
  expect(jigsConfig()).toBe(before);
  expect(ensureLabel).not.toHaveBeenCalled();
});

test("an installation name the hub could not have is refused", async () => {
  await expect(bindRepo(API, deps(), { installation: "Acme_GH" })).rejects.toThrow(
    'invalid installation name "Acme_GH"',
  );
});

test("a re-bind without --installation keeps the binding's own installation", async () => {
  writeConfig(`api: { remote: ${JSON.stringify(API)}, installationName: "gh" }`);
  const before = jigsConfig();
  const ensureLabel = vi.fn().mockResolvedValue("verified");
  const result = await bindRepo(API, deps({ ensureLabel }));
  expect(result.installationName).toBe("gh");
  expect(jigsConfig()).toBe(before);
  expect(ensureLabel).toHaveBeenCalledWith(expect.objectContaining({ installationName: "gh" }));
});

test("--installation moves an existing binding to another installation", async () => {
  writeConfig(`api: { remote: ${JSON.stringify(API)}, installationName: "gh" }`);
  await bindRepo(API, deps(), { installation: "gh-other" });
  expect(jigsConfig()).toContain(`installationName: "gh-other"`);
  expect(jigsConfig()).not.toContain(`installationName: "gh"`);
  expect(lines).toContain(`api now points at ${API} through gh-other`);
});

test("bind reuses an alias whose remote already matches", async () => {
  const remote = "git@github.com:acme/gambit-infrastructure.git";
  writeConfig(
    `// keep this alias\n gambit: { remote: ${JSON.stringify(remote)}, installationName: "gh" }`,
  );
  const before = jigsConfig();

  const result = await bindRepo(remote, deps(), { installation: "gh" });

  expect(result.name).toBe("gambit");
  expect(jigsConfig()).toBe(before);
  expect(jigsConfig()).not.toContain("gambitinfrastructure");
  expect(lines).toContain(`gambit already points at ${remote} through gh`);
});

test("--binding-name creates a separate binding even when another name has the remote", async () => {
  await bindRepo(API, deps(), { installation: "gh", name: "gambit" });

  const result = await bindRepo(API, deps(), { installation: "gh", name: "forge" });

  expect(result.name).toBe("forge");
  expect(jigsConfig()).toContain("gambit:");
  expect(jigsConfig()).toContain("forge:");
});

test("an invalid --binding-name errors even when another name has the remote", async () => {
  await bindRepo(API, deps(), { installation: "gh", name: "gambit" });

  await expect(bindRepo(API, deps(), { installation: "gh", name: "bad name!" })).rejects.toThrow(
    "invalid binding name",
  );
});

test("an invalid alias from config is refused", async () => {
  writeConfig(`"bad name!": { remote: ${JSON.stringify(API)}, installationName: "gh" }`);

  await expect(bindRepo(API, deps(), { installation: "gh" })).rejects.toThrow(
    "invalid binding name",
  );
});

test("an implicit name uses the first binding when a remote is bound more than once", async () => {
  writeConfig(
    `gambit: { remote: ${JSON.stringify(API)}, installationName: "gh" }, forge: { remote: ${JSON.stringify(API)}, installationName: "gh" }`,
  );

  const result = await bindRepo(API, deps(), { installation: "gh" });

  expect(result.name).toBe("gambit");
});

test("re-bind refuses an expression-backed remote", async () => {
  await bindRepo(API, deps(), { installation: "gh" });
  const expressionConfig = `const remote = ${JSON.stringify(API)};\n${jigsConfig().replace(
    `remote: "${API}"`,
    "remote",
  )}`;
  writeFileSync(path.join(factory, "jigs.config.ts"), expressionConfig);

  await expect(bindRepo(API, deps(), { installation: "gh" })).rejects.toThrow(
    "Cannot edit bindings",
  );

  expect(jigsConfig()).toBe(expressionConfig);
});

test("a prototype-chain repo name creates an own binding", async () => {
  const remote = "git@github.com:acme/constructor.git";

  const result = await bindRepo(remote, deps(), { installation: "gh" });

  expect(result).toMatchObject({ name: "constructor", remote });
  expect(jigsConfig()).toContain("constructor:");
});

test("bind creates a derived-name entry when no binding has the remote", async () => {
  await bindRepo("git@github.com:acme/gambit-infrastructure.git", deps(), {
    installation: "gh",
    name: "gambit",
  });

  const result = await bindRepo(API, deps(), { installation: "gh" });

  expect(result.name).toBe("api");
  expect(jigsConfig()).toContain("api:");
  expect(jigsConfig()).toContain(`remote: "${API}"`);
});

test("a new binding says jigs up applies and clones it", async () => {
  await bindRepo(API, deps(), { installation: "gh" });
  expect(lines.slice(-3)).toEqual([
    "",
    "to apply the config and clone api, run:",
    "  pnpm exec jigs up",
  ]);
});

test("a non-github remote's name comes from the last path segment", async () => {
  const result = await bindRepo("git@gitlab.com:acme/Other-Thing.git", deps(), {
    installation: "gh",
  });
  expect(result.name).toBe("other-thing");
});

test("re-bind is idempotent: no duplicate entries, comments preserved, bytes unchanged", async () => {
  writeConfig(`// keep me\n api: { remote: ${JSON.stringify(API)}, installationName: "gh" }`);
  const before = jigsConfig();

  await bindRepo(API, deps(), { installation: "gh" });
  expect(jigsConfig()).toBe(before);
  expect(lines.some((l) => l.includes("already points at"))).toBe(true);
});

function markCloned(bindingName: string): void {
  const originRefs = path.join(
    cloneRepoDir({ factoryRoot: factory, bindingName }),
    "refs/remotes/origin",
  );
  mkdirSync(originRefs, { recursive: true });
  writeFileSync(path.join(originRefs, "HEAD"), "ref: refs/heads/main\n");
}

test("a binding whose clone is already on disk needs no restart", async () => {
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
  writeConfig(`api: { remote: ${JSON.stringify(API)}, installationName: "gh" }`);
  markCloned("api");

  await bindRepo(API, deps(), { installation: "gh" });
  expect(lines.some((l) => l.includes("pnpm exec jigs up"))).toBe(false);
});

test("a name re-bound after an unbind says jigs up applies the changed config", async () => {
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
  writeConfig(`api: { remote: ${JSON.stringify(API)}, installationName: "gh" }`);
  markCloned("api");
  unbindRepo("api", deps());

  await bindRepo("git@github.com:acme/api-moved.git", deps(), { installation: "gh", name: "api" });
  expect(lines.slice(-3)).toEqual([
    "",
    "to apply the config and clone api, run:",
    "  pnpm exec jigs up",
  ]);
});

test("a name already bound to another remote is refused, hinting unbind", async () => {
  writeConfig(`api: { remote: ${JSON.stringify(API)}, installationName: "gh" }`);
  const failure = await bindRepo("git@github.com:acme/api-moved.git", deps(), {
    installation: "gh",
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
  const result = await bindRepo(API, deps(), { installation: "gh", name: "forge" });
  expect(result.name).toBe("forge");
  expect(jigsConfig()).toContain("forge:");
});

test("invalid binding name errors", async () => {
  await expect(bindRepo(API, deps(), { installation: "gh", name: "bad name!" })).rejects.toThrow(
    "invalid binding name",
  );
});

test("a path argument is refused with the remote-URL hint", async () => {
  const before = jigsConfig();
  for (const arg of ["../some-target-repo", tmp, "~/Code/api"]) {
    await expect(bindRepo(arg, deps(), { installation: "gh" })).rejects.toThrow(
      "looks like a path",
    );
  }
  expect(jigsConfig()).toBe(before);
});

test("a remote starting with a dash is refused before it can become a git option", async () => {
  const before = jigsConfig();
  await expect(
    bindRepo("--upload-pack=touch /tmp/pwned", deps(), { installation: "gh" }),
  ).rejects.toThrow("starts with a dash");
  expect(jigsConfig()).toBe(before);
});

test("bind outside a factory repo fails with guidance", async () => {
  await expect(bindRepo(API, deps({ cwd: tmp }), { installation: "gh" })).rejects.toThrow(
    "not inside a factory repo",
  );
});

// ---- the label leg ----------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const failLabel = (err: unknown) => deps({ ensureLabel: vi.fn().mockRejectedValue(err) });

test("the label leg without a hub token fails with the hub's repair, after recording the binding", async () => {
  vi.stubEnv("JIGS_HUB_TOKEN", "");

  const failure = await bindRepo(
    API,
    { cwd: factory, out: (line) => lines.push(line) },
    { installation: "gh" },
  ).catch((err: unknown) => err);

  expect(jigsConfig()).toContain(`remote: "${API}"`);
  expect(String(failure)).toContain("jigs:approved label could not be ensured");
  expect((failure as { hint?: string }).hint).toContain(
    "set JIGS_HUB_TOKEN in the factory's environment",
  );
  expect((failure as { hint?: string }).hint).toContain(`re-run: \`pnpm exec jigs bind ${API}`);
});

test("bind ensures every jigs label on every run, whatever the approval", async () => {
  writeFileSync(
    path.join(factory, "jigs.config.ts"),
    'export default { github: { mergeApproval: "label" }, hub: { url: "https://hub.example.test" }, service: { port: 8990, dashboardPort: 9090 }, workflows: {} };',
  );
  const ensureLabel = vi.fn().mockResolvedValueOnce("created").mockResolvedValueOnce("verified");

  await bindRepo(API, deps({ ensureLabel }), { installation: "gh" });
  await bindRepo(API, deps({ ensureLabel }), { installation: "gh" });

  expect(ensureLabel).toHaveBeenCalledTimes(2 * JIGS_LABELS.length);
  expect(ensureLabel).toHaveBeenCalledWith({
    installationName: "gh",
    owner: "acme",
    repo: "Api",
    label: expect.objectContaining({ name: "jigs:approved" }),
    context: expect.objectContaining({ root: factory }),
  });
  expect(lines).toContain("label created: acme/Api#jigs:approved");
  expect(lines).toContain("label verified: acme/Api#jigs:approved");
});

test("a factory approving by review still gets the jigs labels", async () => {
  const ensureLabel = vi.fn().mockResolvedValue("verified");
  writeFileSync(
    path.join(factory, "jigs.config.ts"),
    'export default { github: { operator: "me" }, hub: { url: "https://hub.example.test" }, service: { port: 8990, dashboardPort: 9090 }, workflows: {} };',
  );

  await bindRepo(API, deps({ ensureLabel }), { installation: "gh" });

  expect(ensureLabel).toHaveBeenCalledTimes(JIGS_LABELS.length);
});

test("a label permission failure preserves the binding, and the retry clones it", async () => {
  const failure = await bindRepo(
    API,
    failLabel(
      new GitHubApiError(403, "/repos/acme/Api/labels", "Resource not accessible by integration"),
    ),
    { installation: "gh" },
  ).catch((err: unknown) => err);

  expect(jigsConfig()).toContain(`remote: "${API}"`);
  expect(String(failure)).toContain("jigs:approved label could not be ensured");
  expect((failure as { hint?: string }).hint).toContain('"Issues: read & write"');
  expect((failure as { hint?: string }).hint).toContain(`re-run: \`pnpm exec jigs bind ${API}`);

  lines = [];
  await bindRepo(API, deps(), { installation: "gh" });
  // The failed run wrote the binding but nothing cloned it.
  expect(lines.slice(-3)).toEqual([
    "",
    "to apply the config and clone api, run:",
    "  pnpm exec jigs up",
  ]);
});

test("the repair carries --binding-name, so the retry lands on the same binding", async () => {
  const failure = await bindRepo(API, failLabel(new Error("no token")), {
    installation: "gh",
    name: "forge",
  }).catch((err: unknown) => err);
  expect((failure as { hint?: string }).hint).toContain(
    `re-run: \`pnpm exec jigs bind ${API} --binding-name forge`,
  );
});

test("an alias match is named in the repair command", async () => {
  writeConfig(`gambit: { remote: ${JSON.stringify(API)}, installationName: "gh" }`);

  const failure = await bindRepo(API, failLabel(new Error("no token")), {
    installation: "gh",
  }).catch((err: unknown) => err);

  expect((failure as { hint?: string }).hint).toContain(
    `re-run: \`pnpm exec jigs bind ${API} --binding-name gambit`,
  );
});

test("a failure GitHub did not lay on the token does not send the operator after one", async () => {
  const failure = await bindRepo(API, failLabel(new Error("fetch failed")), {
    installation: "gh",
  }).catch((err: unknown) => err);
  expect(String(failure)).toContain("fetch failed");
  const { hint } = failure as { hint?: string };
  expect(hint).not.toContain("grant");
  expect(hint).toContain(`pnpm exec jigs bind ${API}`);
});

test("a token GitHub rejects fails with the credential repair", async () => {
  const failure = await bindRepo(
    API,
    failLabel(new GitHubApiError(401, "/repos/acme/Api/labels", "Bad credentials")),
    { installation: "gh" },
  ).catch((err: unknown) => err);
  expect(String(failure)).toContain("401");
  expect((failure as { hint?: string }).hint).toContain("grant the factory's GitHub App");
});

test("a rate-limited 403 does not send the operator after a new token", async () => {
  const failure = await bindRepo(
    API,
    failLabel(
      new GitHubApiError(403, "/repos/acme/Api/labels", "You have exceeded a secondary rate limit"),
    ),
    { installation: "gh" },
  ).catch((err: unknown) => err);
  const { hint } = failure as { hint?: string };
  expect(hint).not.toContain("grant");
  expect(hint).toContain(`once that clears, re-run: \`pnpm exec jigs bind ${API}`);
});

test("a 404 sends the operator to the remote, not to a new token", async () => {
  const failure = await bindRepo(
    API,
    failLabel(new GitHubApiError(404, "/repos/acme/Api/labels", "Not Found")),
    { installation: "gh" },
  ).catch((err: unknown) => err);
  const { hint } = failure as { hint?: string };
  expect(hint).not.toContain("grant");
  expect(hint).toContain("check the remote");
  expect(hint).toContain("acme/Api");
});

test("bind with a non-github remote skips the label leg", async () => {
  const ensureLabel = vi.fn();
  await bindRepo("git@gitlab.com:acme/api.git", deps({ ensureLabel }), { installation: "gh" });
  expect(lines.some((l) => l.includes("not a github.com remote"))).toBe(true);
  expect(ensureLabel).not.toHaveBeenCalled();
});

test("unsupported bindings fail before modifying files or ensuring labels", async () => {
  const text = `const bindings = {}; export default { hub: { url: "https://hub.example.test" }, service: { dashboardPort: 9090 }, bindings };`;
  writeFileSync(path.join(factory, "jigs.config.ts"), text);
  const ensureLabel = vi.fn();
  await expect(bindRepo(API, deps({ ensureLabel }), { installation: "gh" })).rejects.toThrow(
    "Cannot edit bindings in jigs.config.ts",
  );
  expect(jigsConfig()).toBe(text);
  expect(ensureLabel).not.toHaveBeenCalled();
});

const bindingFiles = (name: string) => path.join(factory, "bindings", name);
const CREATED_API = "created bindings/api/ (files the binding's copy lists go into each worktree)";

test("a first bind creates the binding's files folder with a README", async () => {
  await bindRepo(API, deps(), { installation: "gh" });

  const readme = readFileSync(path.join(bindingFiles("api"), "README.md"), "utf8");
  expect(readme).toContain("`bindings/api/.env` arrives as `.env` at the worktree root");
  expect(readme).toContain("https://salimhamed.github.io/jigs/guide/configuration#bindings");
  expect(lines).toContain(CREATED_API);
});

test("re-binding an existing binding creates its missing files folder", async () => {
  writeConfig(`api: { remote: ${JSON.stringify(API)}, installationName: "gh" }`);

  await bindRepo(API, deps(), { installation: "gh" });

  expect(existsSync(path.join(bindingFiles("api"), "README.md"))).toBe(true);
  expect(lines).toContain(CREATED_API);
});

test("an existing files folder is left untouched", async () => {
  mkdirSync(bindingFiles("api"), { recursive: true });
  writeFileSync(path.join(bindingFiles("api"), "README.md"), "mine\n");
  writeFileSync(path.join(bindingFiles("api"), ".env"), "SECRET=1\n");

  await bindRepo(API, deps(), { installation: "gh" });

  expect(readFileSync(path.join(bindingFiles("api"), "README.md"), "utf8")).toBe("mine\n");
  expect(readFileSync(path.join(bindingFiles("api"), ".env"), "utf8")).toBe("SECRET=1\n");
  expect(lines.some((line) => line.startsWith("created bindings/"))).toBe(false);
});

test("a bind that fails before recording the binding leaves no files folder", async () => {
  writeConfig(`api: { remote: "git@github.com:acme/other.git", installationName: "gh" }`);

  await expect(bindRepo(API, deps(), { installation: "gh" })).rejects.toThrow("already bound");

  expect(existsSync(bindingFiles("api"))).toBe(false);
});

// Every test's output, passing or failing, keeps to the shared layout.
afterEach(() => {
  expect(layoutProblems(lines)).toEqual([]);
});
