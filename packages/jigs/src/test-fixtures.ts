import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, type Mock, onTestFinished, vi } from "vitest";
import type { FactoryContext } from "./config/factory-context.ts";
import { factorySlug } from "./config/paths.ts";
import { JIGS_VERSION, VERSION_HEADER } from "./version.ts";
import { type FactoryConfig, parseFactoryConfig } from "./workflow/factory-schema.ts";

export function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "jigs-test-"));
}

export function removeTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    // Isolated from the developer's git config (init.defaultBranch, signing,
    // hooks) so fixtures behave identically on every machine.
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
}

export interface RemoteBackedRepoOptions {
  defaultBranch?: string;
}

export interface RemoteBackedRepo {
  remoteDir: string;
  checkout: string;
}

export function makeRemoteBackedRepo(
  parent: string,
  options: RemoteBackedRepoOptions = {},
): RemoteBackedRepo {
  const defaultBranch = options.defaultBranch ?? "main";
  const remoteDir = path.join(parent, "remote.git");
  mkdirSync(remoteDir, { recursive: true });
  git(remoteDir, "init", "-q", "--bare", "--initial-branch", defaultBranch);
  const checkout = path.join(parent, "checkout");
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "-q", "--initial-branch", defaultBranch);
  git(checkout, "config", "user.name", "jigs-fixture");
  git(checkout, "config", "user.email", "fixture@jigs.test");
  git(checkout, "remote", "add", "origin", remoteDir);
  writeFileSync(path.join(checkout, "README.md"), "# fixture\n");
  git(checkout, "add", "README.md");
  git(checkout, "commit", "-q", "-m", "initial");
  git(checkout, "push", "-q", "-u", "origin", defaultBranch);
  git(checkout, "remote", "set-head", "origin", defaultBranch);
  return { remoteDir, checkout };
}

// Tests can supply an object or raw TypeScript to exercise invalid configuration.
export function makeFactoryRepo(
  parent: string,
  config: Record<string, unknown> | string = {},
): string {
  const dir = path.join(parent, "factory");
  mkdirSync(dir, { recursive: true });
  const text =
    typeof config === "string"
      ? config
      : `export default ${JSON.stringify({ hub: { url: "https://hub.example.test" }, service: { port: 8990, dashboardPort: 9090 }, workflows: {}, ...config })};\n`;
  writeFileSync(path.join(dir, "jigs.config.ts"), text);
  return dir;
}

// The fetch a service verb makes, answered by `fetchMock` as a service built
// from this same jigs would answer it.
export function stubService(fetchMock: Mock): void {
  vi.stubGlobal("fetch", async (...args: unknown[]) => {
    const res = (await fetchMock(...args)) as Response;
    res.headers.set(VERSION_HEADER, JIGS_VERSION);
    return res;
  });
}

export interface TestContextInit {
  root?: string;
  slug?: string;
  config?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
}

// A context built in memory, with no jigs.config.ts on disk.
export function testFactoryContext(init: TestContextInit = {}): FactoryContext {
  const root = init.root ?? "/factory";
  const env = init.env ?? {};
  let config: FactoryConfig | undefined;
  return {
    root,
    slug: init.slug ?? factorySlug(root),
    get config() {
      config ??= parseFactoryConfig({
        hub: { url: "https://hub.example.test" },
        service: { port: 8990, dashboardPort: 9090 },
        workflows: {},
        ...init.config,
      });
      return config;
    },
    env: (name) => (env[name] === "" ? undefined : env[name]),
  };
}

// Run the rest of the current test from `dir`, as the CLI runs every command from its factory's
// root. Undone when the test finishes.
export function runFrom(dir: string): void {
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
  onTestFinished(() => cwd.mockRestore());
}

// `runFrom` a new factory repo; the caller removes the returned directory.
export function useTestFactory(config: Record<string, unknown> | string = {}): string {
  const parent = makeTmpDir();
  runFrom(makeFactoryRepo(parent, config));
  return parent;
}

// `useTestFactory` around every test of a file.
export function inTestFactory(config: Record<string, unknown> | string = {}): void {
  let parent: string;
  beforeEach(() => {
    parent = useTestFactory(config);
  });
  afterEach(() => removeTmpDir(parent));
}
