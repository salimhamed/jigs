import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Sql } from "postgres";
import type { WorktreeRow } from "./registry.ts";

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

  const bootstrap = path.join(parent, "bootstrap-checkout");
  mkdirSync(bootstrap, { recursive: true });
  git(bootstrap, "init", "-q", "--initial-branch", defaultBranch);
  git(bootstrap, "config", "user.name", "jigs-fixture");
  git(bootstrap, "config", "user.email", "fixture@jigs.test");
  writeFileSync(path.join(bootstrap, "README.md"), "# fixture\n");
  git(bootstrap, "add", "README.md");
  git(bootstrap, "commit", "-q", "-m", "initial");
  git(bootstrap, "remote", "add", "origin", remoteDir);
  git(bootstrap, "push", "-q", "origin", defaultBranch);
  rmSync(bootstrap, { recursive: true, force: true });

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

// Advances a branch on the remote through a throwaway clone, so origin moves
// without the clone under test being touched. Returns the new tip sha.
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

// Fakes the postgres tagged-template client against an in-memory store,
// discriminating exactly as registry.ts's queries do. Anything it does not
// recognise resolves empty.
export function makeFakeSql(store: Map<string, WorktreeRow>): Sql {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join("$").trimStart();
    // DELETE also reads FROM jigs_worktrees, so the verb decides first.
    if (
      statement.startsWith("SELECT") &&
      statement.includes("jigs_worktrees")
    ) {
      // No interpolation is listWorktrees; the real one orders by recency,
      // which insertion order stands in for here.
      if (values.length === 0) return Promise.resolve([...store.values()]);
      if (statement.includes("owner_run_id =")) {
        return Promise.resolve(
          [...store.values()].filter((row) => row.ownerRunId === values[0]),
        );
      }
      const row = store.get(values[0] as string);
      return Promise.resolve(row === undefined ? [] : [row]);
    }
    if (statement.startsWith("INSERT")) {
      const [path, branch, ownerRunId, state, repoDir] = values as [
        string,
        string,
        string,
        string,
        string,
      ];
      store.set(path, { path, branch, ownerRunId, state, repoDir });
      return Promise.resolve([]);
    }
    if (statement.startsWith("UPDATE")) {
      const [state, path] = values as [string, string];
      const row = store.get(path);
      if (row !== undefined) store.set(path, { ...row, state });
      return Promise.resolve([]);
    }
    if (statement.startsWith("DELETE")) {
      store.delete(values[0] as string);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  return sql as unknown as Sql;
}
