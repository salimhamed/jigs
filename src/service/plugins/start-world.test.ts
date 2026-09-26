import { afterEach, expect, test, vi } from "vitest";
import { WorkflowRunNotFoundError } from "workflow/errors";
import type { HarnessKind, HarnessRuntime } from "../../checks/harness-runtime.ts";
import { JigsError } from "../../errors.ts";
import type { RegistrySql } from "../../steps/runtime/registry.ts";
import {
  fenceTerminalWorkflowDeliveries,
  gateOnBindingClones,
  gateOnHarnessRuntimes,
  gateOnRegistry,
  gateOnWebhookSecrets,
  gateOnWorldStart,
} from "./start-world.ts";

const RUN = "wrun_01M2Z000000000000000000000";

function queueFenceHarness(status: string | Error, message: unknown = { runId: RUN }) {
  let wrapped: ((message: unknown, metadata: unknown) => Promise<unknown>) | undefined;
  const downstream = vi.fn(async () => ({ timeoutSeconds: 7 }));
  const get = vi.fn(async () => {
    if (status instanceof Error) throw status;
    return { status };
  });
  const world = {
    runs: { get },
    createQueueHandler: vi.fn((_prefix, handler) => {
      wrapped = handler;
      return async () => new Response(null, { status: 204 });
    }),
  };
  fenceTerminalWorkflowDeliveries(
    world as unknown as Parameters<typeof fenceTerminalWorkflowDeliveries>[0],
  );
  world.createQueueHandler("__wkf_workflow_" as never, downstream as never);
  return {
    downstream,
    get,
    invoke: () => wrapped?.(message, { attempt: 1 }),
    world,
  };
}

test.each(["cancelled", "completed", "failed"])(
  "a %s run's queued delivery is acknowledged before the SDK handler",
  async (status) => {
    const harness = queueFenceHarness(status);

    await expect(harness.invoke()).resolves.toBeUndefined();

    expect(harness.get).toHaveBeenCalledWith(RUN);
    expect(harness.downstream).not.toHaveBeenCalled();
  },
);

test("a live delivery enters the SDK handler and may finish if cancellation wins later", async () => {
  const harness = queueFenceHarness("running");

  await expect(harness.invoke()).resolves.toEqual({ timeoutSeconds: 7 });

  expect(harness.downstream).toHaveBeenCalledWith({ runId: RUN }, { attempt: 1 });
});

test("health checks and other messages without a run id bypass the run fence", async () => {
  const message = { correlationId: "health" };
  const harness = queueFenceHarness("cancelled", message);

  await harness.invoke();

  expect(harness.get).not.toHaveBeenCalled();
  expect(harness.downstream).toHaveBeenCalledWith(message, { attempt: 1 });
});

test("a valid health check carrying its future run id bypasses the run fence", async () => {
  const message = { __healthCheck: true, correlationId: "health", runId: RUN };
  const harness = queueFenceHarness("cancelled", message);

  await expect(harness.invoke()).resolves.toEqual({ timeoutSeconds: 7 });

  expect(harness.get).not.toHaveBeenCalled();
  expect(harness.downstream).toHaveBeenCalledWith(message, { attempt: 1 });
});

test("a resilient first delivery may materialize a run missing from storage", async () => {
  const message = {
    runId: RUN,
    runInput: {
      input: new Uint8Array(),
      deploymentId: "postgres",
      workflowName: "cancelE2e",
      specVersion: 5,
    },
  };
  const harness = queueFenceHarness(new WorkflowRunNotFoundError(RUN), message);

  await expect(harness.invoke()).resolves.toEqual({ timeoutSeconds: 7 });

  expect(harness.get).toHaveBeenCalledWith(RUN);
  expect(harness.downstream).toHaveBeenCalledWith(message, { attempt: 1 });
});

test("an ordinary delivery for a missing run delegates its semantics to the SDK", async () => {
  const error = new WorkflowRunNotFoundError(RUN);
  const harness = queueFenceHarness(error);

  await expect(harness.invoke()).resolves.toEqual({ timeoutSeconds: 7 });

  expect(harness.downstream).toHaveBeenCalledWith({ runId: RUN }, { attempt: 1 });
});

test("a transient run status read rejects so the queue retries without executing", async () => {
  const error = new Error("storage unavailable");
  const harness = queueFenceHarness(error);

  await expect(harness.invoke()).rejects.toBe(error);

  expect(harness.downstream).not.toHaveBeenCalled();
});

test("installing the terminal delivery fence twice wraps a handler once", async () => {
  const harness = queueFenceHarness("running");
  fenceTerminalWorkflowDeliveries(
    harness.world as unknown as Parameters<typeof fenceTerminalWorkflowDeliveries>[0],
  );

  await harness.invoke();

  expect(harness.get).toHaveBeenCalledOnce();
  expect(harness.downstream).toHaveBeenCalledOnce();
});

// Nitro never awaits a plugin, so the only thing that can stop the service is
// the plugin itself.
const connected = () => ({}) as RegistrySql;

afterEach(() => {
  vi.unstubAllEnvs();
});

test("a rejected ensure exits the process instead of leaving the service up", async () => {
  const exits: number[] = [];
  const errors: string[] = [];

  const proceed = await gateOnRegistry({
    sql: connected,
    ensure: () => Promise.reject(new Error("migration 0001_resource_table failed")),
    exit: (code) => exits.push(code),
    error: (line) => errors.push(line),
    log: () => {},
  });

  expect(proceed).toBe(false);
  expect(exits).toEqual([1]);
  expect(errors[0]).toContain("migration 0001_resource_table failed");
});

test("a connection that cannot be opened exits too, rather than throwing past the gate", async () => {
  const exits: number[] = [];
  const errors: string[] = [];

  const proceed = await gateOnRegistry({
    // What a malformed WORKFLOW_POSTGRES_URL does: postgres() throws
    // synchronously, before there is anything to ensure.
    sql: () => {
      throw new TypeError("Invalid URL");
    },
    ensure: () => Promise.reject(new Error("never reached")),
    exit: (code) => exits.push(code),
    error: (line) => errors.push(line),
    log: () => {},
  });

  expect(proceed).toBe(false);
  expect(exits).toEqual([1]);
  expect(errors[0]).toContain("Invalid URL");
});

test("a healthy registry lets the World start", async () => {
  const exits: number[] = [];
  const logs: string[] = [];

  const proceed = await gateOnRegistry({
    sql: connected,
    ensure: () => Promise.resolve(),
    exit: (code) => exits.push(code),
    log: (line) => logs.push(line),
  });

  expect(proceed).toBe(true);
  expect(exits).toEqual([]);
  expect(logs.join("\n")).toContain("jigs registry ensured");
});

test("no configured Postgres exits at the gate instead of starting a registry-less service", async () => {
  vi.stubEnv("WORKFLOW_POSTGRES_URL", "");
  const exits: number[] = [];
  const errors: string[] = [];

  const proceed = await gateOnRegistry({
    ensure: () => Promise.reject(new Error("never reached")),
    exit: (code) => exits.push(code),
    error: (line) => errors.push(line),
    log: () => {},
  });

  expect(proceed).toBe(false);
  expect(exits).toEqual([1]);
  expect(errors[0]).toContain("WORKFLOW_POSTGRES_URL is not set");
});

// The clone gate: what a run against an unreachable remote used to discover
// mid-agent, the service now discovers before it starts.
const forge = {
  name: "forge",
  remote: "git@github.com:acme/forge.git",
  repoDir: "/data/clones/factory/forge/repo.git",
};

test("every declared binding is ensured, and says so before the fetch runs", async () => {
  const ensured: string[] = [];
  const logs: string[] = [];

  const proceed = await gateOnBindingClones({
    bindings: () => [forge],
    ensure: async (options) => {
      // The line is out before the fetch that can hold the boot for minutes.
      expect(logs).toEqual([`[service] binding forge: ensuring clone at ${forge.repoDir}`]);
      ensured.push(`${options.repoDir} ${options.remote}`);
    },
    log: (line) => logs.push(line),
  });

  expect(proceed).toBe(true);
  expect(ensured).toEqual([`${forge.repoDir} ${forge.remote}`]);
});

test("a clone that fails names the binding and exits instead of starting", async () => {
  const exits: number[] = [];
  const errors: string[] = [];

  const proceed = await gateOnBindingClones({
    bindings: () => [forge],
    ensure: () => Promise.reject(new Error("could not fetch git@github.com:acme/forge.git")),
    exit: (code) => exits.push(code),
    error: (line) => errors.push(line),
    log: () => {},
  });

  expect(proceed).toBe(false);
  expect(exits).toEqual([1]);
  expect(errors).toEqual([
    "[service] binding forge: could not fetch git@github.com:acme/forge.git",
  ]);
});

test("a JigsError's repair reaches the log beside the reason", async () => {
  const errors: string[] = [];

  await gateOnBindingClones({
    bindings: () => [forge],
    ensure: () =>
      Promise.reject(new JigsError("could not fetch acme/forge", "give git credentials")),
    exit: () => {},
    error: (line) => errors.push(line),
    log: () => {},
  });

  expect(errors).toEqual([
    "[service] binding forge: could not fetch acme/forge — give git credentials",
  ]);
});

test("a factory config that cannot be read exits too", async () => {
  const exits: number[] = [];
  const errors: string[] = [];

  const proceed = await gateOnBindingClones({
    bindings: () => {
      throw new Error("invalid jigs.config.ts");
    },
    ensure: async () => {},
    exit: (code) => exits.push(code),
    error: (line) => errors.push(line),
    log: () => {},
  });

  expect(proceed).toBe(false);
  expect(exits).toEqual([1]);
  expect(errors[0]).toContain("invalid jigs.config.ts");
});

test("a factory with no bindings clones nothing and still starts", async () => {
  const logs: string[] = [];

  const proceed = await gateOnBindingClones({
    bindings: () => [],
    ensure: () => Promise.reject(new Error("never called")),
    log: (line) => logs.push(line),
  });

  expect(proceed).toBe(true);
  expect(logs).toEqual([]);
});

// Resolution is part of the last gate too: an invalid WORKFLOW_TARGET_WORLD
// rejects from getWorld() before there is a World whose start() can be called.
test("a World target that cannot resolve exits the process with the reason", async () => {
  const exits: number[] = [];
  const errors: string[] = [];
  const own = vi.fn();

  const proceed = await gateOnWorldStart({
    getWorld: () =>
      Promise.reject(
        new Error("Cannot find package '@workflow/missing-world' imported from workflow/runtime"),
      ),
    own,
    exit: (code) => exits.push(code),
    error: (line) => errors.push(line),
  });

  expect(proceed).toBe(false);
  expect(own).not.toHaveBeenCalled();
  expect(exits).toEqual([1]);
  expect(errors).toEqual([
    "[service] world failed to start: Cannot find package '@workflow/missing-world' imported from workflow/runtime",
  ]);
});

test("the resolved World is shared by startup and application-managed shutdown", async () => {
  const exits: number[] = [];
  const world = {
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  let closeOwnedWorld: (() => Promise<void> | undefined) | undefined;
  const proceed = await gateOnWorldStart({
    getWorld: async () => world,
    own: (resolved) => {
      closeOwnedWorld = () => resolved.close?.();
    },
    exit: (code) => exits.push(code),
  });
  await closeOwnedWorld?.();
  expect(proceed).toBe(true);
  expect(world.start).toHaveBeenCalledOnce();
  expect(world.close).toHaveBeenCalledOnce();
  expect(exits).toEqual([]);
});

// Only the gate's decision; the check itself is covered in
// checks/harness-runtime.test.ts.
const passing = (over: Partial<HarnessRuntime> = {}): HarnessRuntime =>
  ({
    harness: "codex",
    path: "/usr/local/bin/codex",
    version: "0.153.4",
    minimum: "0.153.0",
    ok: true,
    line: "codex 0.153.4 at /usr/local/bin/codex (minimum 0.153.0)",
    ...over,
  }) as HarnessRuntime;

const failing = (harness: "claude" | "codex", line: string): HarnessRuntime => ({
  harness,
  path: null,
  version: null,
  minimum: null,
  ok: false,
  line,
  repair: "the service may not have the same PATH as your shell",
});

const USERS = new Map<HarnessKind, string[]>([
  ["codex", ["ship"]],
  ["claude", ["review", "ship"]],
]);

test("a harness CLI the shared check rejects exits the boot before anything costly", async () => {
  const exits: number[] = [];
  const errors: string[] = [];

  const proceed = await gateOnHarnessRuntimes({
    harnesses: async () => USERS,
    runtimes: async () => [passing(), failing("claude", "claude not found on PATH")],
    exit: (code) => exits.push(code),
    error: (line) => errors.push(line),
    log: () => {},
  });

  expect(proceed).toBe(false);
  expect(exits).toEqual([1]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("claude not found on PATH (needed by workflows review, ship)");
  expect(errors[0]).toContain("same PATH as your shell");
});

test("harnesses the shared check accepts are logged and let the boot continue", async () => {
  const logs: string[] = [];
  const exits: number[] = [];

  const proceed = await gateOnHarnessRuntimes({
    harnesses: async () => USERS,
    runtimes: async () => [passing(), passing({ harness: "claude", minimum: null })],
    exit: (code) => exits.push(code),
    log: (line) => logs.push(line),
  });

  expect(proceed).toBe(true);
  expect(exits).toEqual([]);
  expect(logs[0]).toContain("codex 0.153.4 at /usr/local/bin/codex");
});

test("a factory whose workflows require no harness boots without probing any CLI", async () => {
  const exits: number[] = [];
  const logs: string[] = [];

  const proceed = await gateOnHarnessRuntimes({
    harnesses: async () => new Map(),
    exit: (code) => exits.push(code),
    log: (line) => logs.push(line),
  });

  expect(proceed).toBe(true);
  expect(exits).toEqual([]);
  expect(logs).toEqual([]);
});

test("the boot gate checks exactly the harnesses derived from the factory", async () => {
  const checked: string[][] = [];

  await expect(
    gateOnHarnessRuntimes({
      harnesses: async () => new Map([["claude", ["review"]]]),
      runtimes: async (kinds) => {
        checked.push(kinds);
        return [];
      },
      log: () => {},
    }),
  ).resolves.toBe(true);

  expect(checked).toEqual([["claude"]]);
});

const WEBHOOKS = {
  url: "https://factory.example.ts.net",
  github: { enabled: true },
  linear: { enabled: false },
};

test("an enabled provider without its secret refuses the boot and names the variable", async () => {
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
  const exit = vi.fn();
  const error = vi.fn();
  expect(await gateOnWebhookSecrets({ webhooks: async () => WEBHOOKS, exit, error })).toBe(false);
  expect(exit).toHaveBeenCalledWith(1);
  expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("GITHUB_WEBHOOK_SECRET"));
  expect(error.mock.calls[0]?.[0]).not.toContain("LINEAR_WEBHOOK_SECRET");
});

test("both providers on and unsigned name both variables", async () => {
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
  vi.stubEnv("LINEAR_WEBHOOK_SECRET", "");
  const error = vi.fn();
  await gateOnWebhookSecrets({
    webhooks: async () => ({ ...WEBHOOKS, linear: { enabled: true } }),
    exit: vi.fn(),
    error,
  });
  expect(error.mock.calls[0]?.[0]).toContain("GITHUB_WEBHOOK_SECRET and LINEAR_WEBHOOK_SECRET");
});

test.each([
  ["no webhooks section", undefined],
  ["both providers off", { ...WEBHOOKS, github: { enabled: false } }],
])("%s needs no secret to boot", async (_name, webhooks) => {
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
  vi.stubEnv("LINEAR_WEBHOOK_SECRET", "");
  const exit = vi.fn();
  expect(await gateOnWebhookSecrets({ webhooks: async () => webhooks, exit })).toBe(true);
  expect(exit).not.toHaveBeenCalled();
});

test("an enabled provider with its secret boots", async () => {
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "signed");
  expect(await gateOnWebhookSecrets({ webhooks: async () => WEBHOOKS, exit: vi.fn() })).toBe(true);
});
