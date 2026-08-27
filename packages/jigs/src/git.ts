import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CliError } from "./errors.ts";

const execFileAsync = promisify(execFile);

export async function git(
  args: string[],
  cwd: string,
  options: { maxBuffer?: number } = {},
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, ...options });
  return stdout.trim();
}

export async function tryGit(
  args: string[],
  cwd: string,
): Promise<string | null> {
  try {
    return await git(args, cwd);
  } catch {
    return null;
  }
}

export async function checkoutRoot(dir: string): Promise<string | null> {
  return tryGit(["rev-parse", "--show-toplevel"], dir);
}

export async function assertCheckoutRoot(dir: string): Promise<void> {
  const resolved = path.resolve(dir);
  const toplevel = await checkoutRoot(resolved);
  if (toplevel === null) {
    throw new CliError(`${dir} is not a git checkout`);
  }
  if (path.resolve(toplevel) !== resolved) {
    throw new CliError(
      `${dir} is inside a git checkout but is not its root`,
      `bind the checkout root instead: ${toplevel}`,
    );
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
    throw new CliError(
      `${dir} has no git remote`,
      "add one: git remote add origin <url>",
    );
  } else {
    throw new CliError(
      `${dir} has ${names.length} remotes and none is origin (${names.join(", ")})`,
      "designate one by renaming it to origin",
    );
  }
  const url = await git(["remote", "get-url", name], dir);
  return { remote: name, url };
}

// Returns null when the remote answered, git's stderr when it did not. The
// env is what keeps an unauthenticated probe from hanging forever on a
// credential prompt instead of failing inside the timeout.
export async function probeRemoteAuth(
  url: string,
  timeoutMs = 15_000,
): Promise<string | null> {
  try {
    await execFileAsync("git", ["ls-remote", "--heads", url, "HEAD"], {
      cwd: tmpdir(),
      timeout: timeoutMs,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        GIT_SSH_COMMAND: `${process.env.GIT_SSH_COMMAND ?? "ssh"} -oBatchMode=yes`,
      },
    });
    return null;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    return (stderr ?? "").trim() || String(err);
  }
}

// No force: the branch is jigs-owned and only ever appended to, so a plain
// push is create-or-fast-forward and stays idempotent on a re-push.
export async function pushBranch(
  worktreePath: string,
  branch: string,
): Promise<void> {
  await git(["push", "origin", `HEAD:refs/heads/${branch}`], worktreePath);
}

export async function commitsAhead(
  worktreePath: string,
  baseSha: string,
): Promise<number> {
  return Number(
    await git(["rev-list", "--count", `${baseSha}..HEAD`], worktreePath),
  );
}

export async function diffSince(
  worktreePath: string,
  baseSha: string,
  maxChars = 200_000,
): Promise<string> {
  // execFile's 1MB default would reject a large diff outright, well before
  // the caller's own cap gets a say.
  const diff = await git(["diff", `${baseSha}...HEAD`], worktreePath, {
    maxBuffer: 64 * 1024 * 1024,
  });
  return diff.length <= maxChars
    ? diff
    : `${diff.slice(0, maxChars)}\n… (diff truncated)`;
}

export async function deriveDefaultBranch(
  dir: string,
  remote = "origin",
): Promise<string | null> {
  const ref = await tryGit(
    ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`],
    dir,
  );
  if (ref === null) return null;
  const prefix = `refs/remotes/${remote}/`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}
