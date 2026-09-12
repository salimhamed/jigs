import { expect, test } from "vitest";
import { codexAppServerStepSettings, codexExecStepSettings, withCodexAppServer } from "./codex.ts";

test("exec settings inject CODEX_HOME and survive caller-supplied env", () => {
  const settings = codexExecStepSettings({
    cwd: "/worktree",
    codexHome: "/homes/run-1",
    env: { FOO: "bar", CODEX_HOME: "/tampered" },
  });
  expect(settings.env).toEqual({ FOO: "bar", CODEX_HOME: "/homes/run-1" });
  expect(settings.skipGitRepoCheck).toBe(true);
  expect("codexHome" in settings).toBe(false);
});

test("app-server settings force persistent threads and CODEX_HOME", () => {
  const settings = codexAppServerStepSettings({
    cwd: "/worktree",
    codexHome: "/homes/run-1",
    threadMode: "stateless",
    env: { CODEX_HOME: "/tampered" },
  });
  expect(settings.threadMode).toBe("persistent");
  expect(settings.env).toEqual({ CODEX_HOME: "/homes/run-1" });
});

// Real-provider smoke: createCodexAppServer() spawns nothing until first
// model use, so this exercises the actual close() path cheaply. The
// close-on-throw contract is covered in codex-lifecycle.test.ts.
test("withCodexAppServer with the real provider resolves and closes", async () => {
  await expect(withCodexAppServer(async (provider) => typeof provider.close)).resolves.toBe(
    "function",
  );
});
