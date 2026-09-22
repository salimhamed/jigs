import {
  type CodexAppServerProvider,
  type CodexAppServerSettings,
  createCodexAppServer,
} from "ai-sdk-provider-codex-cli";
import { resolveCodexExecutable } from "../harnesses/executables.ts";

export type CodexAppServerStepOptions = CodexAppServerSettings & {
  cwd: string;
  codexHome: string;
};

export function codexAppServerStepSettings(
  options: CodexAppServerStepOptions,
): CodexAppServerSettings {
  const { codexHome, ...settings } = options;
  return {
    ...settings,
    threadMode: "persistent",
    codexPath: settings.codexPath ?? resolveCodexExecutable(),
    env: { ...settings.env, CODEX_HOME: codexHome },
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
