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

export interface TargetRepoOptions {
  name?: string;
  remoteUrl?: string | null;
  files?: Record<string, string>;
  defaultBranch?: string;
}

export function makeTargetRepo(
  parent: string,
  options: TargetRepoOptions = {},
): string {
  const dir = path.join(parent, options.name ?? "target-repo");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  if (options.remoteUrl !== null) {
    git(
      dir,
      "remote",
      "add",
      "origin",
      options.remoteUrl ?? "git@github.com:acme/target-repo.git",
    );
  }
  for (const [file, content] of Object.entries(options.files ?? {})) {
    const filePath = path.join(dir, file);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  if (options.defaultBranch !== undefined) {
    git(
      dir,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      `refs/remotes/origin/${options.defaultBranch}`,
    );
  }
  return dir;
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

// Advances a branch on the remote through a throwaway clone, so origin moves
// without the checkout under test being touched. Returns the new tip sha.
export function commitToRemote(
  parent: string,
  remoteDir: string,
  branch: string,
  files: Record<string, string>,
): string {
  const clone = mkdtempSync(path.join(parent, "remote-clone-"));
  git(clone, "clone", "-q", remoteDir, ".");
  git(clone, "config", "user.name", "jigs-fixture");
  git(clone, "config", "user.email", "fixture@jigs.test");
  const onRemote = git(clone, "ls-remote", "--heads", "origin", branch) !== "";
  if (onRemote) {
    git(clone, "checkout", "-q", branch);
  } else {
    git(clone, "checkout", "-q", "-b", branch);
  }
  for (const [file, content] of Object.entries(files)) {
    const filePath = path.join(clone, file);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", `advance ${branch}`);
  git(clone, "push", "-q", "origin", branch);
  const sha = git(clone, "rev-parse", "HEAD");
  rmSync(clone, { recursive: true, force: true });
  return sha;
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
