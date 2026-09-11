import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
      : `export default ${JSON.stringify({ service: { port: 8990, dashboardPort: 9090 }, workflows: {}, ...config })};\n`;
  writeFileSync(path.join(dir, "jigs.config.ts"), text);
  return dir;
}
