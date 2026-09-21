import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  codexAppServerStepSettings,
  codexExecStepSettings,
  withCodexAppServer,
} from "../drivers/codex-support.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

// These settings look for the CLI eagerly, so every test that is not about
// finding it passes a path instead of needing a codex installed.
const CODEX = "/fake/codex";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("exec settings inject CODEX_HOME and survive caller-supplied env", () => {
  const settings = codexExecStepSettings({
    cwd: "/worktree",
    codexHome: "/homes/run-1",
    codexPath: CODEX,
    env: { FOO: "bar", CODEX_HOME: "/tampered" },
  });
  expect(settings.env).toEqual({ FOO: "bar", CODEX_HOME: "/homes/run-1" });
  expect(settings.skipGitRepoCheck).toBe(true);
  expect(settings.codexPath).toBe(CODEX);
  expect("codexHome" in settings).toBe(false);
});

test("app-server settings force persistent threads and CODEX_HOME", () => {
  const settings = codexAppServerStepSettings({
    cwd: "/worktree",
    codexHome: "/homes/run-1",
    codexPath: CODEX,
    threadMode: "stateless",
    env: { CODEX_HOME: "/tampered" },
  });
  expect(settings.threadMode).toBe("persistent");
  expect(settings.codexPath).toBe(CODEX);
  expect(settings.env).toEqual({ CODEX_HOME: "/homes/run-1" });
});

// Never left to the provider, which would pick a copy from its own
// node_modules before looking at PATH.
test("both surfaces resolve the executable on PATH when the caller names none", () => {
  const tmp = makeTmpDir();
  try {
    const bin = path.join(tmp, "bin");
    mkdirSync(bin);
    const codex = path.join(bin, "codex");
    writeFileSync(codex, "#!/bin/sh\n");
    chmodSync(codex, 0o755);
    vi.stubEnv("PATH", bin);

    expect(codexExecStepSettings({ cwd: "/worktree", codexHome: "/h" }).codexPath).toBe(codex);
    expect(codexAppServerStepSettings({ cwd: "/worktree", codexHome: "/h" }).codexPath).toBe(codex);
  } finally {
    removeTmpDir(tmp);
  }
});

// Real-provider smoke: createCodexAppServer() spawns nothing until first
// model use, so this exercises the actual close() path cheaply. The
// close-on-throw contract is covered in codex-lifecycle.test.ts.
test("withCodexAppServer with the real provider resolves and closes", async () => {
  await expect(withCodexAppServer(async (provider) => typeof provider.close)).resolves.toBe(
    "function",
  );
});
