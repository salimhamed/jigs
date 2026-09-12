import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { createShutdown, SHUTDOWN_BACKSTOP_MS, startOwningSignals } from "./shutdown.ts";

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

// What graphile-worker does inside the World's start, and what the service
// has to undo to be the one that drains the queue.
test("a start that registers its own signal handlers loses them, and ours stay", async () => {
  const signals = new EventEmitter();
  const ours = () => {};
  const theirs = () => {};
  signals.on("SIGTERM", ours);
  signals.on("SIGINT", ours);

  await startOwningSignals(async () => {
    signals.on("SIGTERM", theirs);
    signals.on("SIGINT", theirs);
    signals.on("SIGHUP", theirs);
  }, signals);

  expect(signals.listeners("SIGTERM")).toEqual([ours]);
  expect(signals.listeners("SIGINT")).toEqual([ours]);
  // Only the two the service answers to; the rest stay theirs.
  expect(signals.listeners("SIGHUP")).toEqual([theirs]);
});

test("a graphile handler the strip missed is named in the shutdown log", async () => {
  const h = harness();
  const gracefulHandler = () => {};
  h.install();
  h.signals.on("SIGTERM", gracefulHandler);

  h.signals.emit("SIGTERM");
  await exited(h.exits);

  expect(h.logs[1]).toContain("graphile-worker still handles SIGTERM");
});
