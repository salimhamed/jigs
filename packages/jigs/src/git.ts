import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { CliError } from "./errors.ts";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function tryGit(args: string[], cwd: string): Promise<string | null> {
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

export class RemoteMismatchError extends CliError {
  readonly binding: string;
  readonly pinned: string;
  readonly found: string;

  constructor(binding: string, pinned: string, found: string) {
    super(
      `binding ${binding}: remote mismatch — pinned ${pinned}, found ${found}`,
      `if the checkout moved on purpose, re-pin it: jigs bind <path> --name ${binding}`,
    );
    this.name = "RemoteMismatchError";
    this.binding = binding;
    this.pinned = pinned;
    this.found = found;
  }
}

export function verifyBindingPin(
  binding: string,
  pinned: string,
  found: string,
): void {
  if (pinned !== found) {
    throw new RemoteMismatchError(binding, pinned, found);
  }
}
