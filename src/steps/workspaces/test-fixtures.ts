import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, QueryConfig } from "pg";
import type { RegistrySql, WorktreeRow } from "./registry.ts";

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
// clone and a service's clone cannot drift apart. `cloneDir` is where the
// clone lands, for a test that has to put it where the layout says it lives.
//
// Building it costs fifteen git processes, so a suite that rebuilds it per
// test case is the first hook to blow its budget on a loaded CI runner. Build
// it once per worker and copy the directories instead — every caller still
// gets a remote and a clone it alone writes to.
export function makeClonedBinding(
  parent: string,
  cloneDir: string = path.join(parent, "binding"),
): ClonedBinding {
  const template = clonedBindingTemplate();
  const remoteDir = path.join(parent, "remote.git");
  const repoDir = path.join(cloneDir, "repo.git");
  cpSync(template.remoteDir, remoteDir, { recursive: true });
  cpSync(template.repoDir, repoDir, { recursive: true });
  // The copy arrives pointing at the template's remote, which it must not share.
  git(repoDir, "remote", "set-url", "origin", remoteDir);
  return { remoteDir, repoDir, worktreesDir: path.join(cloneDir, "worktrees") };
}

let template: ClonedBinding | undefined;

function clonedBindingTemplate(): ClonedBinding {
  if (template === undefined) {
    const dir = mkdtempSync(path.join(tmpdir(), "jigs-binding-template-"));
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    template = buildClonedBinding(dir, path.join(dir, "binding"));
  }
  return template;
}

function buildClonedBinding(parent: string, cloneDir: string): ClonedBinding {
  const defaultBranch = "main";
  const remoteDir = path.join(parent, "remote.git");
  git(parent, "init", "-q", "--bare", "--initial-branch", defaultBranch, remoteDir);

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

  const repoDir = path.join(cloneDir, "repo.git");
  mkdirSync(cloneDir, { recursive: true });
  git(cloneDir, "init", "-q", "--bare", repoDir);
  // commit-tree and friends need an identity, and the fixture git() reads no
  // global config.
  git(repoDir, "config", "user.name", "jigs-fixture");
  git(repoDir, "config", "user.email", "fixture@jigs.test");
  git(repoDir, "remote", "add", "origin", remoteDir);
  git(repoDir, "fetch", "-q", "origin");
  git(repoDir, "remote", "set-head", "origin", "-a");
  return {
    remoteDir,
    repoDir,
    worktreesDir: path.join(cloneDir, "worktrees"),
  };
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

// Exercise real Drizzle query generation/mapping against an in-memory pg
// transport. Live registry tests cover PostgreSQL semantics and ordering.
export function makeFakeSql(store: Map<string, WorktreeRow>): RegistrySql {
  const pool = {
    async query(config: QueryConfig & { rowMode?: string }, values: unknown[]) {
      const statement = config.text.replaceAll('"', "").trimStart().toUpperCase();
      let rows: WorktreeRow[] = [];
      if (statement.startsWith("SELECT") && statement.includes("JIGS_WORKTREES")) {
        if (values.length === 0) rows = [...store.values()];
        else if (statement.includes("OWNER_RUN_ID =")) {
          rows = [...store.values()].filter((row) => row.ownerRunId === values[0]);
        } else {
          const row = store.get(values[0] as string);
          rows = row === undefined ? [] : [row];
        }
      } else if (statement.startsWith("INSERT")) {
        const [path, branch, ownerRunId, state, repoDir] = values as [
          string,
          string,
          string,
          string,
          string,
        ];
        store.set(path, {
          path: path,
          branch: branch,
          ownerRunId: ownerRunId,
          state: state,
          repoDir: repoDir,
        });
      } else if (statement.startsWith("UPDATE")) {
        const [state, path] = values as [string, string];
        const row = store.get(path);
        if (row !== undefined) store.set(path, { ...row, state });
      } else if (statement.startsWith("DELETE")) {
        store.delete(values[0] as string);
      }
      return {
        rows:
          config.rowMode === "array"
            ? rows.map((row) => [row.path, row.branch, row.ownerRunId, row.state, row.repoDir])
            : rows,
      };
    },
  };
  return drizzle(pool as unknown as Pool);
}
