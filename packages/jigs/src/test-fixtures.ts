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

// A factory config that declares no service block does not parse — both ports
// are required — and most callers here are about bindings, so one is supplied
// unless the caller declares its own.
const SERVICE_BLOCK = "service:\n  port: 8990\n  dashboard_port: 9090\n";

export function makeFactoryRepo(parent: string, jigsYml = ""): string {
  const dir = path.join(parent, "factory");
  mkdirSync(dir, { recursive: true });
  const text = jigsYml.includes("service:")
    ? jigsYml
    : `${jigsYml}${SERVICE_BLOCK}`;
  writeFileSync(path.join(dir, "jigs.yml"), text);
  return dir;
}
