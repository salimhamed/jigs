import { afterEach, expect, test, vi } from "vitest";
import type { HarnessRuntime } from "../../checks/harness-runtime.ts";
import { JigsError } from "../../errors.ts";
import type { RegistrySql } from "../../steps/workspaces/registry.ts";
import {
  gateOnBindingClones,
  gateOnHarnessRuntimes,
  gateOnWorktreeRegistry,
  gateOnWorldStart,
} from "./start-world.ts";

// Nitro never awaits a plugin, so the only thing that can stop the service is
// the plugin itself.
const connected = () => ({}) as RegistrySql;

afterEach(() => {
  vi.unstubAllEnvs();
});

test("a rejected ensure exits the process instead of leaving the service up", async () => {
  const exits: number[] = [];
  const errors: string[] = [];

  const proceed = await gateOnWorktreeRegistry({
    sql: connected,
    ensure: () => Promise.reject(new Error("jigs_worktrees predates repo_dir")),
    exit: (code) => exits.push(code),
    error: (line) => errors.push(line),
    log: () => {},
  });

  expect(proceed).toBe(false);
  expect(exits).toEqual([1]);
  expect(errors[0]).toContain("jigs_worktrees predates repo_dir");
});

test("a connection that cannot be opened exits too, rather than throwing past the gate", async () => {
  const exits: number[] = [];
  const errors: string[] = [];

  const proceed = await gateOnWorktreeRegistry({
    // What a malformed WORKFLOW_POSTGRES_URL does: postgres() throws
    // synchronously, before there is anything to ensure.
    sql: () => {
      throw new TypeError("Invalid URL");
    },
    ensure: () => Promise.reject(new Error("never reached")),
    exit: (code) => exits.push(code),
    error: (line) => errors.push(line),
    log: () => {},
  });

  expect(proceed).toBe(false);
  expect(exits).toEqual([1]);
  expect(errors[0]).toContain("Invalid URL");
});

test("a healthy registry lets the World start", async () => {
  const exits: number[] = [];
  const logs: string[] = [];

  const proceed = await gateOnWorktreeRegistry({
    sql: connected,
    ensure: () => Promise.resolve(),
    exit: (code) => exits.push(code),
    log: (line) => logs.push(line),
  });

  expect(proceed).toBe(true);
  expect(exits).toEqual([]);
  expect(logs.join("\n")).toContain("worktree registry ensured");
});

test("no configured Postgres exits at the gate instead of starting a registry-less service", async () => {
  vi.stubEnv("WORKFLOW_POSTGRES_URL", "");
  const exits: number[] = [];
  const errors: string[] = [];

  const proceed = await gateOnWorktreeRegistry({
    ensure: () => Promise.reject(new Error("never reached")),
    exit: (code) => exits.push(code),
    error: (line) => errors.push(line),
    log: () => {},
  });

  expect(proceed).toBe(false);
  expect(exits).toEqual([1]);
  expect(errors[0]).toContain("WORKFLOW_POSTGRES_URL is not set");
});

// The clone gate: what a run against an unreachable remote used to discover
// mid-agent, the service now discovers before it starts.
const forge = {
  name: "forge",
  remote: "git@github.com:acme/forge.git",
  repoDir: "/data/bindings/factory/forge/repo.git",
};

test("every declared binding is ensured, and says so before the fetch runs", async () => {
  const ensured: string[] = [];
  const logs: string[] = [];

  const proceed = await gateOnBindingClones({
    bindings: () => [forge],
    ensure: async (options) => {
      // The line is out before the fetch that can hold the boot for minutes.
      expect(logs).toEqual([`[service] binding forge: ensuring clone at ${forge.repoDir}`]);
      ensured.push(`${options.repoDir} ${options.remote}`);
    },
    log: (line) => logs.push(line),
  });

  expect(proceed).toBe(true);
  expect(ensured).toEqual([`${forge.repoDir} ${forge.remote}`]);
});

test("a clone that fails names the binding and exits instead of starting", async () => {
  const exits: number[] = [];
  const errors: string[] = [];

  const proceed = await gateOnBindingClones({
    bindings: () => [forge],
    ensure: () => Promise.reject(new Error("could not fetch git@github.com:acme/forge.git")),
    exit: (code) => exits.push(code),
    error: (line) => errors.push(line),
    log: () => {},
  });

  expect(proceed).toBe(false);
  expect(exits).toEqual([1]);
  expect(errors).toEqual([
    "[service] binding forge: could not fetch git@github.com:acme/forge.git",
  ]);
});

test("a JigsError's repair reaches the log beside the reason", async () => {
  const errors: string[] = [];

  await gateOnBindingClones({
    bindings: () => [forge],
    ensure: () =>
      Promise.reject(new JigsError("could not fetch acme/forge", "give git credentials")),
    exit: () => {},
    error: (line) => errors.push(line),
    log: () => {},
  });

  expect(errors).toEqual([
    "[service] binding forge: could not fetch acme/forge — give git credentials",
  ]);
});

test("a factory config that cannot be read exits too", async () => {
  const exits: number[] = [];
  const errors: string[] = [];

  const proceed = await gateOnBindingClones({
    bindings: () => {
      throw new Error("invalid jigs.config.ts");
    },
    ensure: async () => {},
    exit: (code) => exits.push(code),
    error: (line) => errors.push(line),
    log: () => {},
  });

  expect(proceed).toBe(false);
  expect(exits).toEqual([1]);
  expect(errors[0]).toContain("invalid jigs.config.ts");
});

test("a factory with no bindings clones nothing and still starts", async () => {
  const logs: string[] = [];

  const proceed = await gateOnBindingClones({
    bindings: () => [],
    ensure: () => Promise.reject(new Error("never called")),
    log: (line) => logs.push(line),
  });

  expect(proceed).toBe(true);
  expect(logs).toEqual([]);
});

// The World's start is the last gate: left to nitro, its rejection is a
// console.error and a process that stays up, never ready.
test("a World that fails to start exits the process with the reason", async () => {
  const exits: number[] = [];
  const errors: string[] = [];

  const proceed = await gateOnWorldStart({
    start: () => Promise.reject(new Error('Invalid version string: "bundled"')),
    exit: (code) => exits.push(code),
    error: (line) => errors.push(line),
  });

  expect(proceed).toBe(false);
  expect(exits).toEqual([1]);
  expect(errors).toEqual(['[service] world failed to start: Invalid version string: "bundled"']);
});

test("a World that starts lets the boot finish", async () => {
  const exits: number[] = [];
  const proceed = await gateOnWorldStart({
    start: async () => {},
    exit: (code) => exits.push(code),
  });
  expect(proceed).toBe(true);
  expect(exits).toEqual([]);
});

// Only the gate's decision; the check itself is covered in
// checks/harness-runtime.test.ts.
const passing = (over: Partial<HarnessRuntime> = {}): HarnessRuntime =>
  ({
    harness: "codex",
    path: "/usr/local/bin/codex",
    version: "0.153.4",
    minimum: "0.153.0",
    ok: true,
    line: "codex 0.153.4 at /usr/local/bin/codex (minimum 0.153.0)",
    ...over,
  }) as HarnessRuntime;

const failing = (harness: "claude" | "codex", line: string): HarnessRuntime => ({
  harness,
  path: null,
  version: null,
  minimum: null,
  ok: false,
  line,
  repair: "the service may not have the same PATH as your shell",
});

test("a harness CLI the shared check rejects exits the boot before anything costly", async () => {
  const exits: number[] = [];
  const errors: string[] = [];

  const proceed = await gateOnHarnessRuntimes({
    runtimes: async () => [passing(), failing("claude", "claude not found on PATH")],
    exit: (code) => exits.push(code),
    error: (line) => errors.push(line),
    log: () => {},
  });

  expect(proceed).toBe(false);
  expect(exits).toEqual([1]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("claude not found on PATH");
  expect(errors[0]).toContain("same PATH as your shell");
});

test("harnesses the shared check accepts are logged and let the boot continue", async () => {
  const logs: string[] = [];
  const exits: number[] = [];

  const proceed = await gateOnHarnessRuntimes({
    runtimes: async () => [passing(), passing({ harness: "claude", minimum: null })],
    exit: (code) => exits.push(code),
    log: (line) => logs.push(line),
  });

  expect(proceed).toBe(true);
  expect(exits).toEqual([]);
  expect(logs[0]).toContain("codex 0.153.4 at /usr/local/bin/codex");
});
