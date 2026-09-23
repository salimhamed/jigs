import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  type CodexAppServerProvider,
  type CodexAppServerSettings,
  createCodexAppServer,
} from "ai-sdk-provider-codex-cli";
import { resolveCodexExecutable } from "../harnesses/executables.ts";

export type CodexAppServerStepOptions = CodexAppServerSettings & {
  cwd: string;
  codexHome: string;
  env: Record<string, string>;
};

// The provider sets it on every launch.
const PROVIDER_ENV = ["RUST_LOG"];

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// The provider launches the app server under the whole host environment plus
// ours, with no hook to replace it. This launcher keeps only the variables the
// step names, by reference, so no value is written to disk.
export function writeCodexLauncher(dir: string, codex: string, names: readonly string[]): string {
  const kept = [...new Set([...names, ...PROVIDER_ENV])].map((name) => `${name}="$${name}"`);
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

export async function withCodexAppServer<T>(
  fn: (provider: CodexAppServerProvider) => Promise<T>,
): Promise<T> {
  const provider = createCodexAppServer();
  try {
    return await fn(provider);
  } finally {
    await provider.close();
  }
}
