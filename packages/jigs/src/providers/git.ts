import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { processEnv } from "../config/factory-context.ts";
import { githubAuthFor } from "./github-auth.ts";

const execFileAsync = promisify(execFile);

// What keeps a command that needs credentials from hanging forever on a
// prompt instead of failing where the caller can report it. Every git call
// jigs makes runs unattended, so `git`/`tryGit` merge this in unconditionally.
// LC_ALL because callers match on git's messages, which are gettext-translated
// under the operator's locale; it also outranks LANGUAGE.
function nonInteractiveGitEnv(): NodeJS.ProcessEnv {
  return { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", LC_ALL: "C" };
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
    env: { ...processEnv(), ...nonInteractiveGitEnv(), ...env },
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

// Returns null when the remote answered, git's stderr when it did not. The
// timeout is the caller's to state: the binding check that probes has a
// deadline of its own, and this call has to finish inside it.
export async function probeRemoteAuth(
  url: string,
  token: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    await execFileAsync("git", ["ls-remote", "--heads", url, "HEAD"], {
      cwd: tmpdir(),
      timeout: timeoutMs,
      env: { ...processEnv(), ...nonInteractiveGitEnv(), ...githubTokenEnv(token) },
    });
    return null;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    return (stderr ?? "").trim() || String(err);
  }
}

export function scrubCredentials(text: string): string {
  return text.replace(/\/\/[^/@\s]+@/g, "//***@");
}

// git reads `GIT_CONFIG_KEY_n`/`VALUE_n` as if they were `-c` settings, but
// without putting them where another process can read them. Settings already
// in `env` keep their indexes; these follow them.
export function gitConfigEnv(
  settings: readonly (readonly [string, string])[],
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const first = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  const added: Record<string, string> = { GIT_CONFIG_COUNT: String(first + settings.length) };
  for (const [offset, [key, value]] of settings.entries()) {
    added[`GIT_CONFIG_KEY_${first + offset}`] = key;
    added[`GIT_CONFIG_VALUE_${first + offset}`] = value;
  }
  return added;
}

/**
 * The setting that sends a GitHub token with every request to github.com, or only to the
 * repositories under `owner` when one is given.
 */
export function githubAuthHeader(token: string, owner?: string): [string, string] {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const prefix = owner === undefined ? "https://github.com/" : `https://github.com/${owner}/`;
  return [`http.${prefix}.extraheader`, `Authorization: Basic ${basic}`];
}

// An installation token lives an hour and must not reach `.git/config`, a log
// line or argv (any local user reads `/proc/<pid>/cmdline`), so it travels as
// an `Authorization` header in git's environment-variable config, for the life
// of one command.
function githubTokenEnv(token: string): Record<string, string> {
  return gitConfigEnv([githubAuthHeader(token)], processEnv());
}

/** The git config key a binding clone keeps its GitHub installation's name under. */
export const CLONE_INSTALLATION_KEY = "jigs.installation";

/**
 * Run a git command that reaches a binding clone's origin, as the clone's GitHub installation,
 * with a token minted for this one command.
 */
export async function remoteGit(args: string[], dir: string): Promise<string> {
  const installationName = await git(["config", CLONE_INSTALLATION_KEY], dir);
  return git(args, dir, githubTokenEnv(await githubAuthFor(installationName).bearer()));
}

/** What a push did to the remote branch. */
export interface Pushed {
  /** Whether this push created the branch on the remote. */
  created: boolean;
}

// No force: the branch is jigs-owned and only ever appended to, so a plain
// push is create-or-fast-forward and stays idempotent on a re-push.
export async function pushBranch(worktreePath: string, branch: string): Promise<Pushed> {
  return push(worktreePath, `HEAD:refs/heads/${branch}`);
}

/** Push an exact commit even if the local branch moves before Git sends it. */
export async function pushCommit(
  worktreePath: string,
  branch: string,
  commit: string,
): Promise<Pushed> {
  return push(worktreePath, `${commit}:refs/heads/${branch}`);
}

// Porcelain output flags each ref it updated; `*` is a ref the push created.
async function push(worktreePath: string, refspec: string): Promise<Pushed> {
  const out = await remoteGit(["push", "--porcelain", "origin", refspec], worktreePath);
  return { created: out.split("\n").some((line) => line.startsWith("*\t")) };
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

export async function deriveDefaultBranch(dir: string): Promise<string | null> {
  const ref = await tryGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], dir);
  const prefix = "refs/remotes/origin/";
  return ref?.startsWith(prefix) ? ref.slice(prefix.length) : null;
}
