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

export function makeFactoryRepo(parent: string, jigsYml = ""): string {
  const dir = path.join(parent, "factory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "jigs.yml"), jigsYml);
  return dir;
}
