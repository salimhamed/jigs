import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import semver from "semver";
import { MIN_PI_VERSION, resolvePiExecutable } from "./executables.ts";

export function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "jigs-harness-test-"));
}

export function removeTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function hasSupportedPi(): boolean {
  try {
    const answer = spawnSync(resolvePiExecutable(process.env), ["--version"], { encoding: "utf8" });
    const version = semver.coerce(`${answer.stdout}${answer.stderr}`, { includePrerelease: true });
    return answer.status === 0 && version !== null && semver.gte(version, MIN_PI_VERSION);
  } catch {
    return false;
  }
}

// CI installs Pi, so a missing one there is a broken setup, not a reason to skip.
export function skipWithoutSupportedPi(): boolean {
  if (hasSupportedPi()) return false;
  if (process.env.CI) throw new Error(`CI needs pi >= ${MIN_PI_VERSION} on PATH`);
  return true;
}

export interface CodexInvocationHomeState {
  authIsSymlink: boolean;
  authLinkTarget: string | null;
  entries: string[];
  configToml: string;
}

// Test-side inspection of a Codex invocation home. Deliberately test-only:
// invocation homes are private temporary state, and doctor runs without a launch.
export function codexInvocationHomeState(home: string): CodexInvocationHomeState {
  const authPath = path.join(home, "auth.json");
  let authIsSymlink = false;
  let authLinkTarget: string | null = null;
  try {
    authIsSymlink = lstatSync(authPath).isSymbolicLink();
    authLinkTarget = authIsSymlink ? readlinkSync(authPath) : null;
  } catch {
    // missing auth.json reads as not-a-symlink
  }
  return {
    authIsSymlink,
    authLinkTarget,
    entries: readdirSync(home).sort(),
    configToml: readFileSync(path.join(home, "config.toml"), "utf8"),
  };
}
