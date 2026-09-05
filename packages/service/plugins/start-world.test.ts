import type { ISql } from "postgres";
import { expect, test } from "vitest";
import { gateOnWorktreeRegistry } from "./start-world";

// Nitro never awaits a plugin, so the only thing that can stop the service is
// the plugin itself.
const connected = () => ({}) as ISql;

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

test("no configured Postgres skips the registry and still starts", async () => {
  const logs: string[] = [];

  const proceed = await gateOnWorktreeRegistry({
    sql: () => null,
    ensure: () => Promise.reject(new Error("never called")),
    log: (line) => logs.push(line),
  });

  expect(proceed).toBe(true);
  expect(logs.join("\n")).toContain("WORKFLOW_POSTGRES_URL unset");
});
