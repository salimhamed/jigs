import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "jigs-harness-test-"));
}

export function removeTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface ManagedCodexHomeState {
  authIsSymlink: boolean;
  authLinkTarget: string | null;
  entries: string[];
  configToml: string;
}

// Test-side inspection of a managed Codex home. Deliberately test-only:
// managed homes are per-run state, and jigs doctor runs without a launch.
export function managedCodexHomeState(home: string): ManagedCodexHomeState {
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
