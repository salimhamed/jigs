import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Message } from "@jigs-ai/hub-protocol";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resumeHook } from "workflow/api";
import { testFactoryContext } from "../test-fixtures.ts";
import { JIGS_VERSION } from "../version.ts";
import { hubBackoff, startHubClient } from "./hub-client.ts";

vi.mock("workflow/api", () => ({ resumeHook: vi.fn() }));
const resumeHookMock = vi.mocked(resumeHook);

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

// Each GET takes the next reply: messages, or a bare status. With none left the
// hub holds the poll open, as a real one does while nothing arrives.
async function fakeHub(replies: (Message[] | number)[]) {
  const seen: Seen[] = [];
  const held: ServerResponse[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      // Tools on the machine probe new ports; only the hub API is the client's.
      if (!req.url?.startsWith("/api/factory/")) return void res.writeHead(404).end();
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.method === "POST") return void res.writeHead(204).end();
      const reply = replies.shift();
      if (reply === undefined) return void held.push(res);
      if (typeof reply === "number") return void res.writeHead(reply).end();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages: reply }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    held,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

const event = (position: string, payload: unknown): Message => ({
  position,
  kind: "event",
  event: {
    id: `evt_${position}`,
    provider: "pagerduty",
    name: "incident.triggered",
    receivedAt: "2026-10-04T00:00:00.000Z",
    payload,
  },
});

const push = vi.fn<(provider: string, event: unknown) => Promise<string[]>>();
const route = { context: testFactoryContext({ slug: "factory-test" }), push };
let errors: ReturnType<typeof vi.spyOn>;
let hub: Awaited<ReturnType<typeof fakeHub>> | undefined;
let stop: (() => Promise<void>) | undefined;

beforeEach(() => {
  push.mockReset().mockResolvedValue([]);
  resumeHookMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  await stop?.();
  await hub?.close();
  stop = undefined;
  hub = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function start(replies: (Message[] | number)[], nudge = {}) {
  hub = await fakeHub(replies);
  stop = startHubClient({ url: hub.url, token: "fct_secret", route, nudge }).stop;
  return hub;
}

// Real sockets under fake timers: let I/O run until the condition holds.
async function until(condition: () => boolean) {
  for (let i = 0; i < 10_000 && !condition(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(condition()).toBe(true);
}

test("routes a batch in order, then confirms its last position", async () => {
  const { seen } = await start([[event("7", "first"), event("9", "second")]]);
  await vi.waitFor(() => expect(seen.filter((r) => r.method === "POST")).toHaveLength(1));

  expect(push.mock.calls).toEqual([
    ["pagerduty", "first"],
    ["pagerduty", "second"],
  ]);
  const [poll, confirm] = seen;
  expect(poll?.method).toBe("GET");
  expect(poll?.url).toBe("/api/factory/messages?wait=30");
  expect(confirm?.url).toBe("/api/factory/cursor");
  expect(JSON.parse(confirm?.body ?? "")).toEqual({ position: "9" });
  for (const request of seen) {
    expect(request.headers.authorization).toBe("Bearer fct_secret");
    expect(request.headers["user-agent"]).toBe(`jigs/${JIGS_VERSION}`);
  }
});

test("a message that fails to route is logged and still confirmed", async () => {
  push.mockRejectedValueOnce(new Error("registry unreachable"));
  const { seen } = await start([[event("3", "bad"), event("4", "good")]]);
  await vi.waitFor(() => expect(seen.some((r) => r.method === "POST")).toBe(true));

  expect(push).toHaveBeenCalledTimes(2);
  expect(JSON.parse(seen.find((r) => r.method === "POST")?.body ?? "")).toEqual({ position: "4" });
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("could not route pagerduty event evt_3"),
  );
});

test("fell behind wakes every waiting run once, then confirms", async () => {
  resumeHookMock.mockResolvedValue({ runId: "wrun_A" } as never);
  const hooks = async () => [
    { runId: "wrun_A", token: "github:pr:acme/api#1" },
    { runId: "wrun_B", token: "slack:thread:C0C5EUZ7P9Q:1790723478.961719" },
  ];
  const { seen } = await start([[{ position: "12", kind: "fellBehind" }]], {
    hooks,
    busyRuns: async () => [],
    log: () => undefined,
  });
  await vi.waitFor(() => expect(seen.some((r) => r.method === "POST")).toBe(true));

  expect(resumeHookMock.mock.calls.map(([token]) => token)).toEqual([
    "github:pr:acme/api#1",
    "slack:thread:C0C5EUZ7P9Q:1790723478.961719",
  ]);
  expect(JSON.parse(seen.find((r) => r.method === "POST")?.body ?? "")).toEqual({ position: "12" });
  expect(errors).toHaveBeenCalledWith(expect.stringContaining("dropped provider events"));
});

test("stopping aborts the poll in flight", async () => {
  const { held } = await start([]);
  await vi.waitFor(() => expect(held).toHaveLength(1));
  const closed = new Promise((resolve) => held[0]?.on("close", resolve));

  await stop?.();
  await closed;
  expect(errors).not.toHaveBeenCalled();
});

test("stopping mid-batch routes no further message and confirms nothing", async () => {
  let release = () => {};
  push.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([]))));
  const { seen } = await start([[event("5", "first"), event("6", "second")]]);
  await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));

  const stopped = stop?.();
  release();
  await stopped;
  expect(push).toHaveBeenCalledTimes(1);
  expect(seen.filter((r) => r.method === "POST")).toHaveLength(0);
});

test("backs off on a server error, doubling up to a minute", async () => {
  expect([1, 2, 3, 7, 20].map(hubBackoff)).toEqual([1000, 2000, 4000, 60_000, 60_000]);

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { seen } = await start([503, 502, [event("1", "after")]]);
  const polls = () => seen.filter((r) => r.method === "GET").length;
  await until(() => polls() === 1 && errors.mock.calls.length === 1);
  expect(errors).toHaveBeenLastCalledWith(expect.stringContaining("retrying in 1s"));

  await vi.advanceTimersByTimeAsync(999);
  expect(polls()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await until(() => polls() === 2 && errors.mock.calls.length === 2);
  expect(errors).toHaveBeenLastCalledWith(expect.stringContaining("retrying in 2s"));

  await vi.advanceTimersByTimeAsync(2000);
  await until(() => push.mock.calls.length === 1);
});

test("a rejected token is reported and retried slowly", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { seen } = await start([401, [event("1", "after")]]);
  await until(() => errors.mock.calls.length === 1);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining("rejected the factory token"));

  await vi.advanceTimersByTimeAsync(60_000);
  expect(seen).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(4 * 60_000);
  await until(() => push.mock.calls.length === 1);
});
