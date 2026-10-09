import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { JigsError } from "../../errors.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir, runFrom } from "../../test-fixtures.ts";
import { JIGS_VERSION, VERSION_HEADER } from "../../version.ts";
import {
  resolveServiceUrl,
  ServiceVersionMismatch,
  serviceFetch,
  usesFactoryService,
} from "./service-client.ts";

let tmp: string;

beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  removeTmpDir(tmp);
  vi.unstubAllGlobals();
});

// The env var reaches this function as `explicit`: commander's `.env()`
// fills the option before the action runs.
test("an explicit --service-url / JIGS_SERVICE_URL wins over the factory config", () => {
  runFrom(
    makeFactoryRepo(tmp, {
      hub: { url: "https://hub.example.test" },
      service: { port: 9100, dashboardPort: 9200 },
    }),
  );
  expect(resolveServiceUrl("http://elsewhere:1234")).toBe("http://elsewhere:1234");
});

test("without an explicit url the factory the user stands in names its service", () => {
  runFrom(
    makeFactoryRepo(tmp, {
      hub: { url: "https://hub.example.test" },
      service: { port: 9100, dashboardPort: 9200 },
    }),
  );
  expect(resolveServiceUrl()).toBe("http://localhost:9100");
});

// One rule decides both where the run goes and whose sources the freshness
// warning speaks about, so `JIGS_SERVICE_URL=` has to read as unset in both.
test("an empty --service-url / JIGS_SERVICE_URL names no service at all", () => {
  runFrom(
    makeFactoryRepo(tmp, {
      hub: { url: "https://hub.example.test" },
      service: { port: 9100, dashboardPort: 9200 },
    }),
  );
  expect(usesFactoryService("")).toBe(true);
  expect(resolveServiceUrl("")).toBe("http://localhost:9100");
});

test("a factory with no service section keeps the historic port", () => {
  runFrom(makeFactoryRepo(tmp, { bindings: {} }));
  expect(resolveServiceUrl()).toBe("http://localhost:8990");
});

test("outside a factory repo, with no explicit url, the walk fails with guidance", () => {
  runFrom(tmp);
  expect(() => resolveServiceUrl()).toThrow(/not inside a factory repo/);
});

test("an unreachable service names the url and the lifecycle verbs", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
  const failure = await serviceFetch("http://svc.test:9100", "/api/doctor").then(
    () => null,
    (err: unknown) => err as JigsError,
  );
  expect(failure?.message).toContain("http://svc.test:9100");
  expect(failure?.hint).toBe(
    "check whether it is running: `pnpm exec jigs service status`\nstart it: `pnpm exec jigs up`",
  );
});

const answering = (headers: Record<string, string>) =>
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { headers })));

const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (err: unknown) => err as JigsError,
  );

test("a service on this CLI's jigs is answered as is", async () => {
  answering({ [VERSION_HEADER]: JIGS_VERSION });
  const res = await serviceFetch("http://svc.test:9100", "/api/runs");
  expect(await res.json()).toEqual({});
});

test("a service on another jigs is refused before its answer is read", async () => {
  answering({ [VERSION_HEADER]: "0.0.1" });
  const failure = await failureOf(serviceFetch("http://svc.test:9100/", "/api/runs"));
  expect(failure).toBeInstanceOf(ServiceVersionMismatch);
  expect(failure?.message).toBe(
    `the jigs service at http://svc.test:9100 runs jigs 0.0.1, and this CLI is jigs ${JIGS_VERSION}`,
  );
  expect(failure?.hint).toBe("restart it on this factory's jigs: `pnpm exec jigs up`");
});

test("a service that names no version predates the check and is refused as older", async () => {
  answering({});
  const failure = await failureOf(serviceFetch("http://svc.test:9100", "/api/runs"));
  expect(failure).toBeInstanceOf(ServiceVersionMismatch);
  expect(failure?.message).toBe(
    `the jigs service at http://svc.test:9100 runs an older jigs, and this CLI is jigs ${JIGS_VERSION}`,
  );
});
