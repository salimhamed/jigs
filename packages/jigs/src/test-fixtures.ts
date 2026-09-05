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

export interface ClonedBinding {
  remoteDir: string;
  repoDir: string;
  worktreesDir: string;
}

// Builds exactly what ensureBindingClone builds — a bare "GitHub" with one
// commit on its default branch, and jigs' own bare clone of it — so a test's
// clone and a service's clone cannot drift apart.
export function makeClonedBinding(
  parent: string,
  defaultBranch = "main",
): ClonedBinding {
  const remoteDir = path.join(parent, "remote.git");
  git(
    parent,
    "init",
    "-q",
    "--bare",
    "--initial-branch",
    defaultBranch,
    remoteDir,
  );

  const seed = path.join(parent, "seed-checkout");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "--initial-branch", defaultBranch);
  git(seed, "config", "user.name", "jigs-fixture");
  git(seed, "config", "user.email", "fixture@jigs.test");
  writeFileSync(path.join(seed, "README.md"), "# fixture\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-q", "-m", "initial");
  git(seed, "remote", "add", "origin", remoteDir);
  git(seed, "push", "-q", "origin", defaultBranch);
  rmSync(seed, { recursive: true, force: true });

  const binding = path.join(parent, "binding");
  const repoDir = path.join(binding, "repo.git");
  mkdirSync(binding, { recursive: true });
  git(binding, "init", "-q", "--bare", repoDir);
  // commit-tree and friends need an identity, and the fixture git() reads no
  // global config.
  git(repoDir, "config", "user.name", "jigs-fixture");
  git(repoDir, "config", "user.email", "fixture@jigs.test");
  git(repoDir, "remote", "add", "origin", remoteDir);
  git(repoDir, "fetch", "-q", "origin");
  git(repoDir, "remote", "set-head", "origin", "-a");
  return { remoteDir, repoDir, worktreesDir: path.join(binding, "worktrees") };
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
