import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { prepareCodexInvocationHome } from "../../codex-home.ts";
import { resolveClaudeExecutable } from "../../executables.ts";

export const REAL_CODEX_AUTH = path.join(homedir(), ".codex", "auth.json");

// Fail fast with one clear error on a credential-less machine, instead of
// five ten-minute timeouts.
export function assertLivePreconditions(): void {
  if (!existsSync(REAL_CODEX_AUTH)) {
    throw new Error(`live tests need a ChatGPT-authed Codex login: ${REAL_CODEX_AUTH} is missing`);
  }
  resolveClaudeExecutable();
}

export function makeInvocationHome(tmp: string, label: string): string {
  return prepareCodexInvocationHome(`${label}-${crypto.randomUUID().slice(0, 8)}`, {
    baseDir: path.join(tmp, "codex-homes"),
  }).home;
}

export function makeScratchRepo(parent: string, name = "scratch"): string {
  const dir = path.join(parent, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(path.join(dir, "README.md"), "# live-test scratch repo\n");
  return dir;
}

// A control CODEX_HOME that DOES declare the probe MCP server — the live
// control proving the observable (a real tool call) detects registration.
export function makeControlCodexHome(parent: string, probeToken: string): string {
  const home = path.join(parent, "control-home");
  mkdirSync(home, { recursive: true });
  const probeServer = path.join(import.meta.dirname, "mcp-probe-server.mjs");
  writeFileSync(
    path.join(home, "config.toml"),
    [
      "# control home for the isolation test — declares the probe server",
      "[mcp_servers.probe]",
      'command = "node"',
      `args = [${JSON.stringify(probeServer)}]`,
      `env = { PROBE_TOKEN = ${JSON.stringify(probeToken)} }`,
      "",
    ].join("\n"),
  );
  symlinkSync(REAL_CODEX_AUTH, path.join(home, "auth.json"));
  return home;
}

export const PROBE_PROMPT = [
  "You may have an MCP server named 'probe' with a tool get_probe_token.",
  "If that tool is available, call it and reply with exactly the token it returns and nothing else.",
  "If no such tool is available, reply with exactly NO-PROBE-SERVER and nothing else.",
].join("\n");

// A skill whose instructions alone say what the marker holds, so a marker with
// the right token proves the agent loaded the skill.
export function makeMarkerSkill(parent: string): { folder: string; token: string } {
  const folder = path.join(parent, "factory-skills", "jigs-marker");
  mkdirSync(folder, { recursive: true });
  const token = `SKILL-${crypto.randomUUID().slice(0, 8)}`;
  writeFileSync(
    path.join(folder, "SKILL.md"),
    [
      "---",
      "name: jigs-marker",
      "description: How to leave the jigs marker. Use it whenever you are asked to leave the jigs marker.",
      "---",
      "",
      `To leave the jigs marker, create a file named skill-marker.txt in the current working directory containing exactly ${token} on one line.`,
      "",
    ].join("\n"),
  );
  return { folder, token };
}

export const MARKER_PROMPT =
  "Leave the jigs marker in the current working directory, following the skill that explains how. Then reply DONE.";
