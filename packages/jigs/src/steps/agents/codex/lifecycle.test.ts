import type { CodexAppServerProvider } from "ai-sdk-provider-codex-cli";
import { expect, test, vi } from "vitest";
import { harnesses } from "../../../workflow/agents/harness-config.ts";
import { AgentSessionError } from "../shared/session-error.ts";
import { createCodexDriver } from "./driver.ts";

vi.mock("../shared/executables.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/executables.ts")>()),
  resolveCodexExecutable: () => "/fake/codex",
}));

function lifecycle(
  options: {
    sessionFound?: boolean;
    providerThrows?: boolean;
    abortWhilePreparing?: boolean;
    cleanupThrows?: boolean;
  } = {},
) {
  const run = new AbortController();
  const close = vi.fn(async () => {});
  const cleanup = vi.fn(() => {
    if (options.cleanupThrows === true)
      throw Object.assign(new Error("ENOTEMPTY, Directory not empty"), { code: "ENOTEMPTY" });
  });
  const provider = Object.assign(
    () => {
      if (options.providerThrows === true) throw new Error("bad settings");
      return { fake: "codex-model" };
    },
    { close },
  ) as unknown as CodexAppServerProvider;
  const createAppServer = vi.fn(() => provider);
  const driver = createCodexDriver({
    prepareCodexHome: async () => {
      if (options.abortWhilePreparing === true) run.abort(new Error("run cancelled"));
      return { home: "/tmp", sessionDir: "/tmp/sessions", cleanup };
    },
    sessionFile: () => (options.sessionFound === false ? undefined : "/rollout.jsonl"),
    createAppServer,
  });
  const open = (resume?: { id: string }) =>
    driver.open?.(
      {
        harness: harnesses.codex({ model: "gpt-5.5" }),
        cwd: "/work",
        ...(resume === undefined
          ? {}
          : { resume: { harness: "codex", id: resume.id, descriptor: "" } }),
      },
      { metadata: { workflowRunId: "run-1" }, env: {}, signal: run.signal },
    );
  return { open, close, cleanup, createAppServer, run };
}

test("closing the opened model stops the app server and removes the private home", async () => {
  const { open, close, cleanup } = lifecycle();
  const opened = await open();
  expect(close).not.toHaveBeenCalled();
  await opened?.close();
  expect(close).toHaveBeenCalledTimes(1);
  expect(cleanup).toHaveBeenCalledTimes(1);
});

test("a missing session removes the home and never starts an app server", async () => {
  const { open, cleanup, createAppServer } = lifecycle({ sessionFound: false });
  await expect(open({ id: "gone" })).rejects.toBeInstanceOf(AgentSessionError);
  expect(createAppServer).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledTimes(1);
});

test("a provider that rejects its settings is still closed", async () => {
  const { open, close, cleanup } = lifecycle({ providerThrows: true });
  await expect(open()).rejects.toThrow("bad settings");
  expect(close).toHaveBeenCalledTimes(1);
  expect(cleanup).toHaveBeenCalledTimes(1);
});

test("a cancellation while the home is prepared never starts an app server", async () => {
  const { open, cleanup, createAppServer } = lifecycle({ abortWhilePreparing: true });
  await expect(open()).rejects.toThrow("run cancelled");
  expect(createAppServer).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledTimes(1);
});

test("a cancellation closes the app server at once, and close still removes the home", async () => {
  const { open, close, cleanup, run } = lifecycle();
  const opened = await open();
  run.abort(new Error("run cancelled"));
  expect(close).toHaveBeenCalledTimes(1);
  expect(cleanup).not.toHaveBeenCalled();
  await opened?.close();
  expect(cleanup).toHaveBeenCalledTimes(1);
});

test("a home that Codex is still writing into while it exits does not fail the close", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { open, close, cleanup } = lifecycle({ cleanupThrows: true });
    const opened = await open();
    await expect(opened?.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ENOTEMPTY"));
  } finally {
    warn.mockRestore();
  }
});
