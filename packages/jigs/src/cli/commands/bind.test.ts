import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cloneRepoDir } from "../../steps/workspaces/layout.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir, runFrom } from "../../test-fixtures.ts";
import { layoutProblems } from "../output-layout.ts";
import { type BindDeps, bindRepo } from "./bind.ts";
import { unbindRepo } from "./unbind.ts";

let tmp: string;
let factory: string;
let lines: string[];

beforeEach(() => {
  tmp = makeTmpDir();
  factory = makeFactoryRepo(tmp);
  runFrom(factory);
  lines = [];
});
afterEach(() => {
  removeTmpDir(tmp);
});

function deps(overrides: Partial<BindDeps> = {}): BindDeps {
  return {
    out: (line) => lines.push(line),
    ...overrides,
  };
}

const jigsConfig = () => readFileSync(path.join(factory, "jigs.config.ts"), "utf8");
const API = "git@github.com:acme/Api.git";
const writeConfig = (bindings: string, extra = "") =>
  writeFileSync(
    path.join(factory, "jigs.config.ts"),
    `export default { ${extra}hub: { url: "https://hub.example.test" }, bindings: { ${bindings} }, workflows: {} };`,
  );

test("bind writes the remote under a name derived from the repo", () => {
  const result = bindRepo(API, deps(), { installation: "gh" });
  expect(result).toMatchObject({ name: "api", remote: API, installationName: "gh" });
  expect(jigsConfig()).toContain("api:");
  expect(jigsConfig()).toContain(`remote: "${API}"`);
  expect(jigsConfig()).toContain(`installationName: "gh"`);
});

test("a new binding without --installation is refused before anything is written", () => {
  const before = jigsConfig();
  expect(() => bindRepo(API, deps())).toThrow(
    expect.objectContaining({
      message: expect.stringContaining("bind needs the GitHub installation"),
      hint: expect.stringContaining("--installation <installation-name>"),
    }),
  );
  expect(jigsConfig()).toBe(before);
});

test("an installation name the hub could not have is refused", () => {
  expect(() => bindRepo(API, deps(), { installation: "Acme_GH" })).toThrow(
    'invalid installation name "Acme_GH"',
  );
});

test("a re-bind without --installation keeps the binding's own installation", () => {
  writeConfig(`api: { remote: ${JSON.stringify(API)}, installationName: "gh" }`);
  const before = jigsConfig();
  const result = bindRepo(API, deps());
  expect(result.installationName).toBe("gh");
  expect(jigsConfig()).toBe(before);
});

test("--installation moves an existing binding to another installation", () => {
  writeConfig(`api: { remote: ${JSON.stringify(API)}, installationName: "gh" }`);
  bindRepo(API, deps(), { installation: "gh-other" });
  expect(jigsConfig()).toContain(`installationName: "gh-other"`);
  expect(jigsConfig()).not.toContain(`installationName: "gh"`);
  expect(lines).toContain(`api now points at ${API} through gh-other`);
});

test("bind reuses an alias whose remote already matches", () => {
  const remote = "git@github.com:acme/gambit-infrastructure.git";
  writeConfig(
    `// keep this alias\n gambit: { remote: ${JSON.stringify(remote)}, installationName: "gh" }`,
  );
  const before = jigsConfig();

  const result = bindRepo(remote, deps(), { installation: "gh" });

  expect(result.name).toBe("gambit");
  expect(jigsConfig()).toBe(before);
  expect(jigsConfig()).not.toContain("gambitinfrastructure");
  expect(lines).toContain(`gambit already points at ${remote} through gh`);
});

test("--binding-name creates a separate binding even when another name has the remote", () => {
  bindRepo(API, deps(), { installation: "gh", name: "gambit" });

  const result = bindRepo(API, deps(), { installation: "gh", name: "forge" });

  expect(result.name).toBe("forge");
  expect(jigsConfig()).toContain("gambit:");
  expect(jigsConfig()).toContain("forge:");
});

test("an invalid --binding-name errors even when another name has the remote", () => {
  bindRepo(API, deps(), { installation: "gh", name: "gambit" });

  expect(() => bindRepo(API, deps(), { installation: "gh", name: "bad name!" })).toThrow(
    "invalid binding name",
  );
});

test("an invalid alias from config is refused", () => {
  writeConfig(`"bad name!": { remote: ${JSON.stringify(API)}, installationName: "gh" }`);

  expect(() => bindRepo(API, deps(), { installation: "gh" })).toThrow("invalid binding name");
});

test("an implicit name uses the first binding when a remote is bound more than once", () => {
  writeConfig(
    `gambit: { remote: ${JSON.stringify(API)}, installationName: "gh" }, forge: { remote: ${JSON.stringify(API)}, installationName: "gh" }`,
  );

  const result = bindRepo(API, deps(), { installation: "gh" });

  expect(result.name).toBe("gambit");
});

test("re-bind refuses an expression-backed remote", () => {
  bindRepo(API, deps(), { installation: "gh" });
  const expressionConfig = `const remote = ${JSON.stringify(API)};\n${jigsConfig().replace(
    `remote: "${API}"`,
    "remote",
  )}`;
  writeFileSync(path.join(factory, "jigs.config.ts"), expressionConfig);

  expect(() => bindRepo(API, deps(), { installation: "gh" })).toThrow("Cannot edit bindings");

  expect(jigsConfig()).toBe(expressionConfig);
});

test("a prototype-chain repo name creates an own binding", () => {
  const remote = "git@github.com:acme/constructor.git";

  const result = bindRepo(remote, deps(), { installation: "gh" });

  expect(result).toMatchObject({ name: "constructor", remote });
  expect(jigsConfig()).toContain("constructor:");
});

test("bind creates a derived-name entry when no binding has the remote", () => {
  bindRepo("git@github.com:acme/gambit-infrastructure.git", deps(), {
    installation: "gh",
    name: "gambit",
  });

  const result = bindRepo(API, deps(), { installation: "gh" });

  expect(result.name).toBe("api");
  expect(jigsConfig()).toContain("api:");
  expect(jigsConfig()).toContain(`remote: "${API}"`);
});

test("a new binding says jigs up applies and clones it", () => {
  bindRepo(API, deps(), { installation: "gh" });
  expect(lines.slice(-3)).toEqual([
    "",
    "to apply the config and clone api, run:",
    "  pnpm exec jigs up",
  ]);
});

test("a non-github remote's name comes from the last path segment", () => {
  const result = bindRepo("git@gitlab.com:acme/Other-Thing.git", deps(), {
    installation: "gh",
  });
  expect(result.name).toBe("other-thing");
});

test("re-bind is idempotent: no duplicate entries, comments preserved, bytes unchanged", () => {
  writeConfig(`// keep me\n api: { remote: ${JSON.stringify(API)}, installationName: "gh" }`);
  const before = jigsConfig();

  bindRepo(API, deps(), { installation: "gh" });
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

test("a binding whose clone is already on disk needs no restart", () => {
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
  writeConfig(`api: { remote: ${JSON.stringify(API)}, installationName: "gh" }`);
  markCloned("api");

  bindRepo(API, deps(), { installation: "gh" });
  expect(lines.some((l) => l.includes("pnpm exec jigs up"))).toBe(false);
});

test("a name re-bound after an unbind says jigs up applies the changed config", () => {
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
  writeConfig(`api: { remote: ${JSON.stringify(API)}, installationName: "gh" }`);
  markCloned("api");
  unbindRepo("api", deps());

  bindRepo("git@github.com:acme/api-moved.git", deps(), { installation: "gh", name: "api" });
  expect(lines.slice(-3)).toEqual([
    "",
    "to apply the config and clone api, run:",
    "  pnpm exec jigs up",
  ]);
});

test("a name already bound to another remote is refused, hinting unbind", () => {
  writeConfig(`api: { remote: ${JSON.stringify(API)}, installationName: "gh" }`);
  expect(() =>
    bindRepo("git@github.com:acme/api-moved.git", deps(), { installation: "gh", name: "api" }),
  ).toThrow(
    expect.objectContaining({
      message: expect.stringContaining("already bound to"),
      hint: expect.stringContaining("pnpm exec jigs unbind api"),
    }),
  );
  expect(jigsConfig()).not.toContain("api-moved");
});

test("--binding-name overrides the derived name", () => {
  const result = bindRepo(API, deps(), { installation: "gh", name: "forge" });
  expect(result.name).toBe("forge");
  expect(jigsConfig()).toContain("forge:");
});

test("invalid binding name errors", () => {
  expect(() => bindRepo(API, deps(), { installation: "gh", name: "bad name!" })).toThrow(
    "invalid binding name",
  );
});

test("a path argument is refused with the remote-URL hint", () => {
  const before = jigsConfig();
  for (const arg of ["../some-target-repo", tmp, "~/Code/api"]) {
    expect(() => bindRepo(arg, deps(), { installation: "gh" })).toThrow("looks like a path");
  }
  expect(jigsConfig()).toBe(before);
});

test("a remote starting with a dash is refused before it can become a git option", () => {
  const before = jigsConfig();
  expect(() => bindRepo("--upload-pack=touch /tmp/pwned", deps(), { installation: "gh" })).toThrow(
    "starts with a dash",
  );
  expect(jigsConfig()).toBe(before);
});

test("bind outside a factory repo fails with guidance", () => {
  runFrom(tmp);
  expect(() => bindRepo(API, deps(), { installation: "gh" })).toThrow("not inside a factory repo");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("unsupported bindings fail before modifying files", () => {
  const text = `const bindings = {}; export default { hub: { url: "https://hub.example.test" }, bindings };`;
  writeFileSync(path.join(factory, "jigs.config.ts"), text);
  expect(() => bindRepo(API, deps(), { installation: "gh" })).toThrow(
    "Cannot edit bindings in jigs.config.ts",
  );
  expect(jigsConfig()).toBe(text);
});

const bindingFiles = (name: string) => path.join(factory, "bindings", name);
const CREATED_API = "created bindings/api/ (files the binding's copy lists go into each worktree)";

test("a first bind creates the binding's files folder with a README", () => {
  bindRepo(API, deps(), { installation: "gh" });

  const readme = readFileSync(path.join(bindingFiles("api"), "README.md"), "utf8");
  expect(readme).toContain("`bindings/api/.env` arrives as `.env` at the worktree root");
  expect(readme).toContain("https://salimhamed.github.io/jigs/guide/configuration#bindings");
  expect(lines).toContain(CREATED_API);
});

test("re-binding an existing binding creates its missing files folder", () => {
  writeConfig(`api: { remote: ${JSON.stringify(API)}, installationName: "gh" }`);

  bindRepo(API, deps(), { installation: "gh" });

  expect(existsSync(path.join(bindingFiles("api"), "README.md"))).toBe(true);
  expect(lines).toContain(CREATED_API);
});

test("an existing files folder is left untouched", () => {
  mkdirSync(bindingFiles("api"), { recursive: true });
  writeFileSync(path.join(bindingFiles("api"), "README.md"), "mine\n");
  writeFileSync(path.join(bindingFiles("api"), ".env"), "SECRET=1\n");

  bindRepo(API, deps(), { installation: "gh" });

  expect(readFileSync(path.join(bindingFiles("api"), "README.md"), "utf8")).toBe("mine\n");
  expect(readFileSync(path.join(bindingFiles("api"), ".env"), "utf8")).toBe("SECRET=1\n");
  expect(lines.some((line) => line.startsWith("created bindings/"))).toBe(false);
});

test("a bind that fails before recording the binding leaves no files folder", () => {
  writeConfig(`api: { remote: "git@github.com:acme/other.git", installationName: "gh" }`);

  expect(() => bindRepo(API, deps(), { installation: "gh" })).toThrow("already bound");

  expect(existsSync(bindingFiles("api"))).toBe(false);
});

// Every test's output, passing or failing, keeps to the shared layout.
afterEach(() => {
  expect(layoutProblems(lines)).toEqual([]);
});
