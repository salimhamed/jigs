import { writeFileSync } from "node:fs";
import path from "node:path";
import type { CodexAppServerSettings } from "ai-sdk-provider-codex-cli";
import { resolveCodexExecutable } from "../harnesses/executables.ts";

export type CodexAppServerStepOptions = CodexAppServerSettings & {
  cwd: string;
  codexHome: string;
  env: Record<string, string>;
};

// The provider sets it on every launch.
const PROVIDER_ENV = ["RUST_LOG"];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// The provider launches the app server under the whole host environment plus
// ours, with no hook to replace it. This launcher keeps only the variables the
// step names, by reference, so no value is written to disk.
export function writeCodexLauncher(dir: string, codex: string, names: readonly string[]): string {
  const unique = [...new Set([...names, ...PROVIDER_ENV])];
  const invalid = unique.filter((name) => !ENV_NAME.test(name));
  // Each name is spliced into shell source.
  if (invalid.length > 0)
    throw new Error(
      `refusing to launch Codex: ${invalid.length} variable name(s) are not shell-safe`,
    );
  const kept = unique.map((name) => `${name}="$${name}"`);
  const launcher = path.join(dir, "jigs-codex-launch");
  writeFileSync(
    launcher,
    `#!/bin/sh\nexec /usr/bin/env -i ${kept.join(" ")} ${shellQuote(codex)} "$@"\n`,
    { mode: 0o700 },
  );
  return launcher;
}

export function codexAppServerStepSettings(
  options: CodexAppServerStepOptions,
): CodexAppServerSettings {
  const { codexHome, ...settings } = options;
  const env = { ...settings.env, CODEX_HOME: codexHome };
  return {
    ...settings,
    threadMode: "persistent",
    codexPath: writeCodexLauncher(
      codexHome,
      settings.codexPath ?? resolveCodexExecutable(),
      Object.keys(env),
    ),
    env,
  };
}
