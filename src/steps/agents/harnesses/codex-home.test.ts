import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  CURATED_CONFIG_TOML,
  ensureManagedCodexHome,
  managedCodexHomePath,
  removeManagedCodexHome,
} from "./codex-home.ts";
import { makeTmpDir, managedCodexHomeState, removeTmpDir } from "./test-fixtures.ts";

let tmp: string;
let realAuthPath: string;
let opts: { baseDir: string; realAuthPath: string };

beforeEach(() => {
  tmp = makeTmpDir();
  realAuthPath = path.join(tmp, "real-codex", "auth.json");
  mkdirSync(path.dirname(realAuthPath), { recursive: true });
  writeFileSync(realAuthPath, '{"auth_mode":"chatgpt"}');
  opts = { baseDir: path.join(tmp, "codex-homes"), realAuthPath };
});
afterEach(() => {
  removeTmpDir(tmp);
});

test("fresh ensure creates the curated config and the auth symlink", () => {
  const home = ensureManagedCodexHome("run-1", opts);
  const state = managedCodexHomeState(home);
  expect(state.configToml).toBe(CURATED_CONFIG_TOML);
  expect(state.authIsSymlink).toBe(true);
  expect(state.authLinkTarget).toBe(realAuthPath);
  expect(state.entries).toEqual(["auth.json", "config.toml"]);
});

test("re-ensure preserves sessions/ — the home is per-run durable state", () => {
  const home = ensureManagedCodexHome("run-1", opts);
  const rollout = path.join(home, "sessions", "2026-08-26", "rollout-abc.jsonl");
  mkdirSync(path.dirname(rollout), { recursive: true });
  writeFileSync(rollout, "{}");

  ensureManagedCodexHome("run-1", opts);
  expect(readFileSync(rollout, "utf8")).toBe("{}");
});

test("re-ensure re-curates a config.toml codex prepended trust records into", () => {
  const home = ensureManagedCodexHome("run-1", opts);
  writeFileSync(
    path.join(home, "config.toml"),
    `[projects."/some/worktree"]\ntrust_level = "trusted"\n${CURATED_CONFIG_TOML}`,
  );

  ensureManagedCodexHome("run-1", opts);
  expect(managedCodexHomeState(home).configToml).toBe(CURATED_CONFIG_TOML);
});

test("a regular-file auth.json (stale copy) is replaced by the symlink", () => {
  const home = managedCodexHomePath("run-1", opts);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "auth.json"), '{"stale":"copy"}');

  ensureManagedCodexHome("run-1", opts);
  const state = managedCodexHomeState(home);
  expect(state.authIsSymlink).toBe(true);
  expect(state.authLinkTarget).toBe(realAuthPath);
});

test("a symlink to the wrong target is re-pointed", () => {
  const home = ensureManagedCodexHome("run-1", opts);
  const otherAuth = path.join(tmp, "other-auth.json");
  writeFileSync(otherAuth, "{}");
  const relinked = ensureManagedCodexHome("run-1", {
    ...opts,
    realAuthPath: otherAuth,
  });
  expect(managedCodexHomeState(relinked).authLinkTarget).toBe(otherAuth);
  expect(home).toBe(relinked);
});

test("a missing real login throws a repair error", () => {
  expect(() =>
    ensureManagedCodexHome("run-1", {
      ...opts,
      realAuthPath: path.join(tmp, "nope.json"),
    }),
  ).toThrow("no Codex login found");
  expect(() =>
    ensureManagedCodexHome("run-1", {
      ...opts,
      realAuthPath: path.join(tmp, "nope.json"),
    }),
  ).toThrow("codex login");
});

test("path convention honors XDG_DATA_HOME and baseDir", () => {
  expect(managedCodexHomePath("run-1", { baseDir: "/x/y" })).toBe("/x/y/run-1");
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = "/xdg-data";
  try {
    expect(managedCodexHomePath("run-1")).toBe("/xdg-data/jigs/codex-homes/run-1");
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
  }
});

test("removeManagedCodexHome deletes the home", () => {
  const home = ensureManagedCodexHome("run-1", opts);
  removeManagedCodexHome("run-1", opts);
  expect(() => lstatSync(home)).toThrow();
});
