import { expect, test } from "vitest";
import { DEFAULT_MIN_CODEX_VERSION } from "../steps/agent/harnesses/index.ts";
import { harnessRuntime } from "./harness-runtime.ts";

const found = (path: string) => () => path;
const answers =
  (stdout: string, stderr = "") =>
  async () => ({ stdout, stderr });

const one = harnessRuntime;

test("a codex past the provider's floor passes and reports path, version and minimum", async () => {
  const runtime = await one("codex", {
    resolve: found("/usr/local/bin/codex"),
    exec: answers("codex-cli 0.153.4\n"),
  });
  expect(runtime).toMatchObject({
    ok: true,
    path: "/usr/local/bin/codex",
    version: "0.153.4",
    minimum: DEFAULT_MIN_CODEX_VERSION,
  });
  expect(runtime.line).toBe(
    `codex 0.153.4 at /usr/local/bin/codex (minimum ${DEFAULT_MIN_CODEX_VERSION})`,
  );
});

test("a codex below the floor fails, naming both versions and the path", async () => {
  const runtime = await one("codex", {
    resolve: found("/usr/local/bin/codex"),
    exec: answers("codex-cli 0.144.6\n"),
  });
  expect(runtime.ok).toBe(false);
  expect(runtime.line).toBe(
    `codex 0.144.6 at /usr/local/bin/codex is below the minimum ${DEFAULT_MIN_CODEX_VERSION}`,
  );
  expect(runtime.ok === false && runtime.repair).toContain("same PATH as your shell");
});

test("the minimum is a semver comparison, prereleases included", async () => {
  const at = async (version: string) =>
    (await one("codex", { resolve: found("/c"), exec: answers(`codex-cli ${version}`) })).ok;
  expect(await at("0.154.0")).toBe(true);
  expect(await at("1.0.0")).toBe(true);
  expect(await at("0.99.0")).toBe(false);
  expect(await at("0.153.0-alpha.1")).toBe(false);
});

test("a CLI missing from PATH reports not found, with no path and no version", async () => {
  const runtime = await one("codex", {
    resolve: () => {
      throw new Error("no `codex` executable found on PATH");
    },
    exec: answers("unused"),
  });
  expect(runtime).toMatchObject({ ok: false, path: null, version: null });
  expect(runtime.line).toBe(`codex not found on PATH (minimum ${DEFAULT_MIN_CODEX_VERSION})`);
});

test("a CLI that cannot run fails with what the spawn said", async () => {
  const runtime = await one("codex", {
    resolve: found("/usr/local/bin/codex"),
    exec: async () => {
      throw new Error("ENOEXEC");
    },
  });
  expect(runtime.ok).toBe(false);
  expect(runtime.line).toContain("ENOEXEC");
});

test("claude is checked for presence with no floor to be below", async () => {
  const runtime = await one("claude", {
    resolve: found("/home/dev/.local/bin/claude"),
    exec: answers("2.1.270 (Claude Code)\n"),
  });
  expect(runtime).toMatchObject({ ok: true, version: "2.1.270", minimum: null });
  expect(runtime.line).toBe("claude 2.1.270 at /home/dev/.local/bin/claude");
});

// Some CLIs answer --version on stderr.
test("a version printed on stderr counts as an answer", async () => {
  const runtime = await one("codex", {
    resolve: found("/usr/local/bin/codex"),
    exec: answers("", "codex-cli 0.153.4\n"),
  });
  expect(runtime).toMatchObject({ ok: true, version: "0.153.4" });
});

test("an unreadable --version answer is not evidence of a usable CLI", async () => {
  const runtime = await one("claude", {
    resolve: found("/bin/claude"),
    exec: answers("command not found"),
  });
  expect(runtime).toMatchObject({ ok: false, version: null });
  expect(runtime.line).toContain("answered no version");
});
