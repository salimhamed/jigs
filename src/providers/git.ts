import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { JigsError } from "../errors.ts";

const execFileAsync = promisify(execFile);

// What keeps a command that needs credentials from hanging forever on a
// prompt instead of failing where the caller can report it. Every git call
// jigs makes runs unattended, so `git`/`tryGit` merge this in unconditionally.
// LC_ALL because callers match on git's messages, which are gettext-translated
// under the operator's locale; it also outranks LANGUAGE.
function nonInteractiveGitEnv(): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_SSH_COMMAND: `${process.env.GIT_SSH_COMMAND ?? "ssh"} -oBatchMode=yes`,
    LC_ALL: "C",
  };
}

export async function git(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<string> {
  // execFile's 1MB default rejects a large diff outright; the cap is a
  // ceiling, not an allocation.
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...nonInteractiveGitEnv(), ...env },
  });
  return stdout.trim();
}

export async function tryGit(args: string[], cwd: string): Promise<string | null> {
  try {
    return await git(args, cwd);
  } catch {
    return null;
  }
}

export interface ResolvedRemote {
  remote: string;
  url: string;
}

export async function resolveRemoteUrl(dir: string): Promise<ResolvedRemote> {
  const names = (await git(["remote"], dir)).split("\n").filter(Boolean);
  let name: string;
  if (names.includes("origin")) {
    name = "origin";
  } else if (names.length === 1 && names[0] !== undefined) {
    name = names[0];
  } else if (names.length === 0) {
    throw new JigsError(`${dir} has no git remote`, "add one: git remote add origin <url>");
  } else {
    throw new JigsError(
      `${dir} has ${names.length} remotes and none is origin (${names.join(", ")})`,
      "designate one by renaming it to origin",
    );
  }
  const url = await git(["remote", "get-url", name], dir);
  return { remote: name, url };
}

// Returns null when the remote answered, git's stderr when it did not. The
// timeout is the caller's to state: the binding check that probes has a
// deadline of its own, and this call has to finish inside it.
export async function probeRemoteAuth(url: string, timeoutMs: number): Promise<string | null> {
  try {
    // Without --end-of-options a remote of `--upload-pack=<command>` runs
    // that command: git reads it as the option and the trailing `HEAD` as the
    // repository.
    await execFileAsync("git", ["ls-remote", "--heads", "--end-of-options", url, "HEAD"], {
      cwd: tmpdir(),
      timeout: timeoutMs,
      env: { ...process.env, ...nonInteractiveGitEnv() },
    });
    return null;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    return (stderr ?? "").trim() || String(err);
  }
}

/**
 * Where a push goes and, when the remote needs one, the credential it carries.
 *
 * A `token` is a GitHub App installation token: it lives an hour, and it must
 * not reach `.git/config` (persisted), a log line, an error message, the
 * process's own argv (any local user reads `/proc/<pid>/cmdline`), or the
 * World (it would be recorded as a step input). So it is neither written to
 * the remote's configuration nor spelled into the URL: it travels as an
 * `Authorization` header supplied through git's environment-variable config,
 * for the life of this one command. `scrubCredentials` covers the message of
 * anything that still slips through.
 */
export interface PushTarget {
  /** A configured remote name, or a URL with no credential in it. */
  remote: string;
  token?: string;
}

export const DEFAULT_PUSH_TARGET: PushTarget = { remote: "origin" };

export function scrubCredentials(text: string): string {
  return text.replace(/\/\/[^/@\s]+@/g, "//***@");
}

// git reads `GIT_CONFIG_KEY_n`/`VALUE_n` as if they were `-c` settings, but
// without putting them where another process can read them.
function pushEnv(target: PushTarget): NodeJS.ProcessEnv {
  if (target.token === undefined) return {};
  const basic = Buffer.from(`x-access-token:${target.token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/** What a push did to the remote branch. */
export interface Pushed {
  /** Whether this push created the branch on the remote. */
  created: boolean;
}

// No force: the branch is jigs-owned and only ever appended to, so a plain
// push is create-or-fast-forward and stays idempotent on a re-push.
export async function pushBranch(
  worktreePath: string,
  branch: string,
  target: PushTarget = DEFAULT_PUSH_TARGET,
): Promise<Pushed> {
  return push(worktreePath, target, `HEAD:refs/heads/${branch}`);
}

/** Push an exact commit even if the local branch moves before Git sends it. */
export async function pushCommit(
  worktreePath: string,
  branch: string,
  commit: string,
  target: PushTarget = DEFAULT_PUSH_TARGET,
): Promise<Pushed> {
  return push(worktreePath, target, `${commit}:refs/heads/${branch}`);
}

// Porcelain output flags each ref it updated; `*` is a ref the push created.
async function push(worktreePath: string, target: PushTarget, refspec: string): Promise<Pushed> {
  try {
    const out = await git(
      ["push", "--porcelain", "--end-of-options", target.remote, refspec],
      worktreePath,
      pushEnv(target),
    );
    return { created: out.split("\n").some((line) => line.startsWith("*\t")) };
  } catch (error) {
    throw new Error(scrubCredentials(error instanceof Error ? error.message : String(error)));
  }
}

export async function headSha(worktreePath: string): Promise<string> {
  return git(["rev-parse", "HEAD"], worktreePath);
}

export async function commitsAhead(worktreePath: string, baseSha: string): Promise<number> {
  return Number(await git(["rev-list", "--count", `${baseSha}..HEAD`], worktreePath));
}

// Big enough for a run's whole change, small enough that a runaway diff does
// not blow the prompt it is interpolated into.
const MAX_DIFF_CHARS = 200_000;

export async function diffSince(worktreePath: string, baseSha: string): Promise<string> {
  const diff = await git(["diff", `${baseSha}...HEAD`], worktreePath);
  return diff.length <= MAX_DIFF_CHARS
    ? diff
    : `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)`;
}

export async function deriveDefaultBranch(dir: string, remote = "origin"): Promise<string | null> {
  const ref = await tryGit(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`], dir);
  if (ref === null) return null;
  const prefix = `refs/remotes/${remote}/`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}
