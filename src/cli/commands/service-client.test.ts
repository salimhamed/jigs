import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { JigsError } from "../../errors.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import { resolveServiceUrl, serviceFetch, usesFactoryService } from "./service-client.ts";

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
test("an explicit --service / JIGS_SERVICE_URL wins over the factory config", () => {
  const factory = makeFactoryRepo(tmp, {
    service: { port: 9100, dashboardPort: 9200 },
  });
  expect(resolveServiceUrl(factory, "http://elsewhere:1234")).toBe("http://elsewhere:1234");
});

test("without an explicit url the factory the user stands in names its service", () => {
  const factory = makeFactoryRepo(tmp, {
    service: { port: 9100, dashboardPort: 9200 },
  });
  expect(resolveServiceUrl(factory)).toBe("http://localhost:9100");
});

// One rule decides both where the run goes and whose sources the freshness
// warning speaks about, so `JIGS_SERVICE_URL=` has to read as unset in both.
test("an empty --service / JIGS_SERVICE_URL names no service at all", () => {
  const factory = makeFactoryRepo(tmp, {
    service: { port: 9100, dashboardPort: 9200 },
  });
  expect(usesFactoryService("")).toBe(true);
  expect(resolveServiceUrl(factory, "")).toBe("http://localhost:9100");
});

test("a factory with no service block keeps the historic port", () => {
  const factory = makeFactoryRepo(tmp, { bindings: {} });
  expect(resolveServiceUrl(factory)).toBe("http://localhost:8990");
});

test("outside a factory repo, with no explicit url, the walk fails with guidance", () => {
  expect(() => resolveServiceUrl(tmp)).toThrow(/not inside a factory repo/);
});

test("an unreachable service names the url and the lifecycle verbs", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
  const failure = await serviceFetch("http://svc.test:9100", "/api/doctor").then(
    () => null,
    (err: unknown) => err as JigsError,
  );
  expect(failure?.message).toContain("http://svc.test:9100");
  expect(failure?.hint).toBe(
    "jigs service status says whether it is running; jigs service start starts it",
  );
});
