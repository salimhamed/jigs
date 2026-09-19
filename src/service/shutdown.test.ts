import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { createShutdown, SHUTDOWN_BACKSTOP_MS } from "./shutdown.ts";

afterEach(() => {
  vi.useRealTimers();
});

function harness(backstopMs?: number) {
  const signals = new EventEmitter();
  const exits: number[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const shutdown = createShutdown();
  const install = () =>
    shutdown.install({
      signals,
      exit: (code) => exits.push(code),
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
      ...(backstopMs === undefined ? {} : { backstopMs }),
    });
  return { signals, exits, logs, errors, shutdown, install };
}

const exited = (exits: number[]) => vi.waitFor(() => expect(exits.length).toBeGreaterThan(0));

test("SIGTERM runs every closer, registered before or after install, then exits 0", async () => {
  const h = harness();
  const ran: string[] = [];
  h.shutdown.onShutdown(() => {
    ran.push("before");
  });
  h.install();
  h.shutdown.onShutdown(async () => {
    ran.push("after");
  });

  h.signals.emit("SIGTERM");
  await exited(h.exits);

  expect(ran.sort()).toEqual(["after", "before"]);
  expect(h.exits).toEqual([0]);
  expect(h.logs[0]).toBe("[service] SIGTERM received, shutting down");
});

test("a closer that rejects is logged and does not stop the others", async () => {
  const h = harness();
  let closed = false;
  h.shutdown.onShutdown(() => Promise.reject(new Error("pool already ended")));
  h.shutdown.onShutdown(async () => {
    closed = true;
  });
  h.install();

  h.signals.emit("SIGTERM");
  await exited(h.exits);

  expect(closed).toBe(true);
  expect(h.exits).toEqual([0]);
  expect(h.errors).toEqual(["[service] shutdown step failed: pool already ended"]);
});

test("a closer that hangs trips the backstop, which exits 1", async () => {
  vi.useFakeTimers();
  const h = harness();
  h.shutdown.onShutdown(() => new Promise<void>(() => {}));
  h.install();

  h.signals.emit("SIGTERM");
  await vi.advanceTimersByTimeAsync(SHUTDOWN_BACKSTOP_MS - 1);
  expect(h.exits).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);

  expect(h.exits).toEqual([1]);
  expect(h.errors[0]).toContain("shutdown still running");
});

// `jigs service stop` waits ten seconds before it SIGKILLs; the backstop has
// to speak first for the operator to ever see why.
test("the backstop fires before the CLI's stop timeout would", () => {
  expect(SHUTDOWN_BACKSTOP_MS).toBeLessThan(10_000);
});

// A supervisor that repeats SIGTERM, or an operator's second Ctrl+C, must
// land on a listener that is still there: with none left node's default
// disposition would kill the process mid-drain.
test("a repeated signal mid-drain is ignored, and the listener stays registered", async () => {
  const h = harness();
  let release!: () => void;
  let calls = 0;
  h.shutdown.onShutdown(() => {
    calls += 1;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  h.install();

  h.signals.emit("SIGTERM");
  expect(h.signals.listenerCount("SIGTERM")).toBe(1);
  h.signals.emit("SIGTERM");
  h.signals.emit("SIGINT");
  expect(h.exits).toEqual([]);
  release();
  await exited(h.exits);

  expect(calls).toBe(1);
  expect(h.exits).toEqual([0]);
  expect(h.logs).toContain("[service] SIGTERM ignored: already shutting down");
  expect(h.logs).toContain("[service] SIGINT ignored: already shutting down");
  expect(h.signals.listenerCount("SIGTERM")).toBe(1);
});

test("installing twice registers the handlers once", () => {
  const h = harness();
  h.install();
  h.install();
  expect(h.signals.listenerCount("SIGTERM")).toBe(1);
  expect(h.signals.listenerCount("SIGINT")).toBe(1);
});

test("SIGINT shuts down the same way", async () => {
  const h = harness();
  let closed = false;
  h.shutdown.onShutdown(() => {
    closed = true;
  });
  h.install();

  h.signals.emit("SIGINT");
  await exited(h.exits);

  expect(closed).toBe(true);
  expect(h.exits).toEqual([0]);
  expect(h.logs[0]).toBe("[service] SIGINT received, shutting down");
});
