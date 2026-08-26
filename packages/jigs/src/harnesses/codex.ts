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
// Note on resume failures (AGE-311 territory): a stale threadId on codex
// 0.149.x escapes the provider's wrapper as a raw JsonRpcRequestError — match
// /(thread.*not found|no rollout found for thread)/i or treat any resume
// failure as stale.
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
