import { expect, test, vi } from "vitest";
import { notifyRunStarted, onRunStarted, type RunStarted } from "./run-events";

const event = (over: Partial<RunStarted> = {}): RunStarted => ({
  runId: "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
  pipeline: "ticket",
  triggerId: "manual-1",
  logs: "http://localhost:3001/run/wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
  ...over,
});

test("every subscriber hears about a started run", () => {
  const heard: RunStarted[] = [];
  const other: RunStarted[] = [];
  const stopA = onRunStarted((e) => heard.push(e));
  const stopB = onRunStarted((e) => other.push(e));
  notifyRunStarted(event());
  stopA();
  stopB();
  expect(heard).toEqual([event()]);
  expect(other).toEqual([event()]);
});

test("unsubscribing stops the delivery", () => {
  const heard: RunStarted[] = [];
  onRunStarted((e) => heard.push(e))();
  notifyRunStarted(event());
  expect(heard).toEqual([]);
});

test("the origin rides along untouched", () => {
  const heard: RunStarted[] = [];
  const stop = onRunStarted((e) => heard.push(e));
  const origin = {
    kind: "slack-thread" as const,
    channel: "C0RUNS",
    threadTs: "1757.0001",
  };
  notifyRunStarted(event({ origin }));
  stop();
  expect(heard[0]?.origin).toEqual(origin);
});

test("a listener that throws takes neither the run nor the next listener", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const heard: RunStarted[] = [];
  const stopA = onRunStarted(() => {
    throw new Error("slack is down");
  });
  const stopB = onRunStarted((e) => heard.push(e));
  expect(() => notifyRunStarted(event())).not.toThrow();
  stopA();
  stopB();
  expect(heard).toEqual([event()]);
  expect(error.mock.calls[0]?.[0]).toContain("slack is down");
  error.mockRestore();
});
