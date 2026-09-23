import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  codexAppServerStepSettings,
  withCodexAppServer,
  writeCodexLauncher,
} from "../drivers/codex-support.ts";
import { harnessEnv } from "./env.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

// These settings look for the CLI eagerly, so every test that is not about
// finding it passes a path instead of needing a codex installed.
const CODEX = "/fake/codex";

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

test("app-server settings force persistent threads and CODEX_HOME, launched through the env launcher", () => {
  const settings = codexAppServerStepSettings({
    cwd: "/worktree",
    codexHome: tmp,
    codexPath: CODEX,
    threadMode: "stateless",
    env: { CODEX_HOME: "/tampered" },
  });
  expect(settings.threadMode).toBe("persistent");
  expect(settings.env).toEqual({ CODEX_HOME: tmp });
  const launcher = readFileSync(settings.codexPath ?? "", "utf8");
  expect(launcher).toContain(`'${CODEX}' "$@"`);
  expect(launcher).toContain('CODEX_HOME="$CODEX_HOME"');
});

// The provider spawns the app server under its whole host environment plus
// ours; the launcher is what narrows it. A stand-in codex records the names it
// was started with.
test("the real provider launch gives Codex only the step environment", async () => {
  const record = path.join(tmp, "names.json");
  const fake = path.join(tmp, "codex");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify(Object.keys(process.env)));
process.exit(1);
`,
  );
  chmodSync(fake, 0o755);
  vi.stubEnv("SYNTHETIC_DATABASE_URL", "postgres://user:synthetic@db/app");
  vi.stubEnv("SYNTHETIC_PRIVATE_KEY", "synthetic-private-key");
  vi.stubEnv("OPENAI_API_KEY", "synthetic-openai-key");
  vi.stubEnv("SYNTHETIC_DECLARED", "declared");
  const home = path.join(tmp, "home");
  mkdirSync(home);
  const env = harnessEnv(["SYNTHETIC_DECLARED"]);

  await expect(
    withCodexAppServer((provider) =>
      generateText({
        model: provider(
          "gpt-5.5",
          codexAppServerStepSettings({ cwd: tmp, codexHome: home, codexPath: fake, env }),
        ),
        prompt: "never answered",
      }),
    ),
  ).rejects.toThrow();

  const names = new Set<string>(JSON.parse(readFileSync(record, "utf8")));
  expect(names.has("SYNTHETIC_DECLARED"), "declared variable").toBe(true);
  expect(names.has("CODEX_HOME")).toBe(true);
  for (const secret of ["SYNTHETIC_DATABASE_URL", "SYNTHETIC_PRIVATE_KEY", "OPENAI_API_KEY"])
    expect(names.has(secret), `${secret} reached Codex`).toBe(false);
  const allowed = new Set([...Object.keys(env), "CODEX_HOME", "RUST_LOG"]);
  // `env -i` and node add nothing a host could leak, but compare names only.
  expect([...names].filter((name) => !allowed.has(name))).toEqual([]);
});

// Never left to the provider, which would pick a copy from its own
// node_modules before looking at PATH.
test("app-server settings resolve the executable on PATH when the caller names none", () => {
  const bin = path.join(tmp, "bin");
  mkdirSync(bin);
  const codex = path.join(bin, "codex");
  writeFileSync(codex, "#!/bin/sh\n");
  chmodSync(codex, 0o755);
  vi.stubEnv("PATH", bin);

  const launcher = codexAppServerStepSettings({
    cwd: "/worktree",
    codexHome: tmp,
    env: {},
  }).codexPath;
  expect(readFileSync(launcher ?? "", "utf8")).toContain(`'${codex}' "$@"`);
});

// Real-provider smoke: createCodexAppServer() spawns nothing until first
// model use, so this exercises the actual close() path cheaply. The
// close-on-throw contract is covered in codex-lifecycle.test.ts.
test("withCodexAppServer with the real provider resolves and closes", async () => {
  await expect(withCodexAppServer(async (provider) => typeof provider.close)).resolves.toBe(
    "function",
  );
});

test("the launcher refuses a name that is not shell-safe and writes nothing", () => {
  const hostile = 'LC_X";touch pwned;"';
  expect(() => writeCodexLauncher(tmp, CODEX, ["PATH", hostile])).toThrow("not shell-safe");
  expect(existsSync(path.join(tmp, "jigs-codex-launch"))).toBe(false);
  expect(() =>
    codexAppServerStepSettings({
      cwd: tmp,
      codexHome: tmp,
      codexPath: CODEX,
      env: { [hostile]: "x" },
    }),
  ).toThrow("not shell-safe");
});
