import {
  type CodexAppServerProvider,
  type CodexAppServerSettings,
  type CodexExecSettings,
  createCodexAppServer,
} from "ai-sdk-provider-codex-cli";

// Both surfaces force-merge env.CODEX_HOME AFTER caller options: every Codex
// step runs under the managed home (ADR 0011) — that is the deny-by-default
// mechanism on a harness with no strict-config flag.

export type CodexExecStepOptions = CodexExecSettings & {
  cwd: string;
  codexHome: string;
};

export function codexExecStepSettings(
  options: CodexExecStepOptions,
): CodexExecSettings {
  const { codexHome, ...settings } = options;
  return {
    // codex exec refuses a non-git cwd without this; an overridable default
    // (before the spread), unlike the CODEX_HOME invariant below.
    skipGitRepoCheck: true,
    ...settings,
    env: { ...settings.env, CODEX_HOME: codexHome },
  };
}

export type CodexAppServerStepOptions = CodexAppServerSettings & {
  cwd: string;
  codexHome: string;
};

// threadMode 'persistent' is an invariant: only persistent threads write
// rollouts under CODEX_HOME/sessions, and a resuming builder needs them.
export function codexAppServerStepSettings(
  options: CodexAppServerStepOptions,
): CodexAppServerSettings {
  const { codexHome, ...settings } = options;
  return {
    ...settings,
    threadMode: "persistent",
    env: { ...settings.env, CODEX_HOME: codexHome },
  };
}

// The only sanctioned way to touch the app-server surface: created per step,
// closed in finally — the provider's client pool otherwise keeps the step
// process's event loop alive forever.
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
