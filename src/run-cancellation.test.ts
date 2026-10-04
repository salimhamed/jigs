import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FatalError } from "workflow";
import {
  RunCancelledError,
  type RunStatusReader,
  watchRunCancellation,
  withRunCancellation,
} from "./run-cancellation.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Wait = { runId: string; resolve(status: string): void; reject(error: Error): void };

// A World whose status waits the test answers one at a time.
function controlledReader(initial: Record<string, string> = {}): RunStatusReader & {
  waits: Wait[];
  reads: string[];
} {
  const waits: Wait[] = [];
  const reads: string[] = [];
  return {
    waits,
    reads,
    read: async (runId) => {
      reads.push(runId);
      return initial[runId] ?? "running";
    },
    waitForTerminal: (runId) =>
      new Promise((resolve, reject) => {
        waits.push({ runId, resolve, reject });
      }),
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

test("an already cancelled run never starts the action", async () => {
  const reader = controlledReader({ run_a: "cancelled" });
  const action = vi.fn(async () => "ran");

  const attempt = withRunCancellation("run_a", action, reader);

  await expect(attempt).rejects.toBeInstanceOf(RunCancelledError);
  await expect(attempt).rejects.toSatisfy((error) => FatalError.is(error));
  expect(action).not.toHaveBeenCalled();
  expect(reader.waits).toHaveLength(0);
});

test("a failed first read never starts the action and is retryable", async () => {
  const reader: RunStatusReader = {
    read: async () => {
      throw new Error("WorkflowRunNotFoundError: run_a");
    },
    waitForTerminal: async () => "running",
  };
  const action = vi.fn(async () => "ran");

  const attempt = withRunCancellation("run_a", action, reader);

  await expect(attempt).rejects.toThrow(
    "could not read run run_a before starting its agent: WorkflowRunNotFoundError: run_a",
  );
  await expect(attempt).rejects.toSatisfy((error) => !FatalError.is(error));
  expect(action).not.toHaveBeenCalled();
});

test("a cancellation seen while the action runs aborts it once and fails it fatally", async () => {
  const reader = controlledReader();
  const signals: AbortSignal[] = [];
  const attempt = withRunCancellation(
    "run_a",
    (signal) => {
      signals.push(signal);
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("pi exited with code 143")));
      });
    },
    reader,
  );
  const failure = expect(attempt).rejects.toSatisfy(
    (error) =>
      error instanceof RunCancelledError &&
      FatalError.is(error) &&
      (error.cause as Error).message === "pi exited with code 143",
  );
  await flush();
  expect(reader.waits).toHaveLength(1);

  reader.waits[0]?.resolve("cancelled");
  await failure;

  expect(signals[0]?.aborted).toBe(true);
  expect(signals[0]?.reason).toBeInstanceOf(RunCancelledError);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(reader.waits).toHaveLength(1);
});

test("nonterminal timeouts keep watching, paced to the watch interval", async () => {
  const reader = controlledReader();
  const watch = await watchRunCancellation("run_a", reader);

  for (let wait = 0; wait < 3; wait++) {
    await flush();
    expect(reader.waits).toHaveLength(wait + 1);
    // The World answered early with a live status; the next wait is a second later.
    reader.waits[wait]?.resolve("running");
    await vi.advanceTimersByTimeAsync(999);
    expect(reader.waits).toHaveLength(wait + 1);
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(watch.signal.aborted).toBe(false);
  watch.dispose();
});

test("an answer slower than the watch interval waits again at once, with no negative timer", async () => {
  const reader = controlledReader();
  const watch = await watchRunCancellation("run_a", reader);
  await flush();
  const timers = vi.spyOn(globalThis, "setTimeout");

  await vi.advanceTimersByTimeAsync(1_500);
  reader.waits[0]?.resolve("running");
  await flush();

  expect(reader.waits).toHaveLength(2);
  for (const [, ms] of timers.mock.calls) expect(ms ?? 0).toBeGreaterThanOrEqual(0);
  watch.dispose();
});

test("the error says whether the agent was stopped or never started", async () => {
  const refused = withRunCancellation(
    "run_a",
    async () => "ran",
    controlledReader({ run_a: "cancelled" }),
  );
  await expect(refused).rejects.toThrow("run run_a was cancelled, so jigs did not start its agent");

  const reader = controlledReader();
  const stopped = withRunCancellation(
    "run_a",
    (signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    reader,
  );
  const failure = expect(stopped).rejects.toThrow(
    "run run_a was cancelled, so jigs stopped its agent",
  );
  await flush();
  reader.waits[0]?.resolve("cancelled");
  await failure;
});

test("another terminal status ends the watch without aborting", async () => {
  const reader = controlledReader();
  const watch = await watchRunCancellation("run_a", reader);
  await flush();

  reader.waits[0]?.resolve("completed");
  await vi.advanceTimersByTimeAsync(10_000);

  expect(watch.signal.aborted).toBe(false);
  expect(reader.waits).toHaveLength(1);
});

test("read failures are logged and retried with bounded backoff until a read succeeds", async () => {
  const reader = controlledReader();
  const watch = await watchRunCancellation("run_a", reader);
  const delays = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000];

  for (const [failure, ms] of delays.entries()) {
    await flush();
    expect(reader.waits).toHaveLength(failure + 1);
    reader.waits[failure]?.reject(new Error("connection refused"));
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(reader.waits).toHaveLength(failure + 1);
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(console.warn).toHaveBeenCalledWith(
    "[jigs] run run_a: cannot read its status to watch for cancellation (connection refused); retrying in 5000ms",
  );

  await flush();
  reader.waits.at(-1)?.resolve("cancelled");
  await flush();
  expect(watch.signal.aborted).toBe(true);
  expect(console.warn).toHaveBeenLastCalledWith(
    "[jigs] run run_a: watching for cancellation again",
  );
});

test("disposal returns at once with a read in flight and ignores its late answer", async () => {
  const reader = controlledReader();
  let watched: AbortSignal | undefined;
  const result = withRunCancellation(
    "run_a",
    async (signal) => {
      watched = signal;
      await flush();
      return "done";
    },
    reader,
  );
  await flush();
  expect(reader.waits).toHaveLength(1);

  await expect(result).resolves.toBe("done");

  reader.waits[0]?.resolve("cancelled");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(watched?.aborted).toBe(false);
  expect(reader.waits).toHaveLength(1);
});

test("a read that fails after disposal is observed and not retried", async () => {
  const reader = controlledReader();
  const watch = await watchRunCancellation("run_a", reader);
  await flush();
  watch.dispose();

  reader.waits[0]?.reject(new Error("pool closed"));
  await vi.advanceTimersByTimeAsync(10_000);

  expect(console.warn).not.toHaveBeenCalled();
  expect(reader.waits).toHaveLength(1);
});

test("cancelling one run leaves another run's watch alone", async () => {
  const reader = controlledReader();
  const first = await watchRunCancellation("run_a", reader);
  const second = await watchRunCancellation("run_b", reader);
  await flush();

  for (const wait of reader.waits) wait.resolve(wait.runId === "run_a" ? "cancelled" : "running");
  await vi.advanceTimersByTimeAsync(1_000);

  expect(first.signal.aborted).toBe(true);
  expect(second.signal.aborted).toBe(false);
  expect(reader.waits.filter((wait) => wait.runId === "run_b")).toHaveLength(2);
  second.dispose();
});

test("an error from an uncancelled run passes through unchanged", async () => {
  const reader = controlledReader();
  const error = new Error("pi exited with code 9");

  await expect(
    withRunCancellation(
      "run_a",
      async () => {
        throw error;
      },
      reader,
    ),
  ).rejects.toBe(error);
});
