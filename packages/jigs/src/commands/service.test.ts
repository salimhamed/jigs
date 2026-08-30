import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CliError } from "../errors.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { resolveServiceTarget, serviceFetch } from "./service.ts";

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
  const factory = makeFactoryRepo(tmp, "service:\n  port: 9100\n");
  expect(resolveServiceTarget(factory, "http://elsewhere:1234")).toEqual({
    serviceUrl: "http://elsewhere:1234",
  });
});

test("without an explicit url the factory the user stands in names its service", () => {
  const factory = makeFactoryRepo(tmp, "service:\n  port: 9100\n");
  expect(resolveServiceTarget(factory)).toEqual({
    serviceUrl: "http://localhost:9100",
    factoryRoot: factory,
  });
});

test("a factory with no service block keeps the historic port", () => {
  const factory = makeFactoryRepo(tmp, "bindings: {}\n");
  expect(resolveServiceTarget(factory).serviceUrl).toBe(
    "http://localhost:8990",
  );
});

test("outside a factory repo, with no explicit url, the walk fails with guidance", () => {
  expect(() => resolveServiceTarget(tmp)).toThrow(/not inside a factory repo/);
});

test("an unreachable service names the factory and the start verb", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new TypeError("fetch failed")),
  );
  const failure = await serviceFetch(
    { serviceUrl: "http://svc.test:9100", factoryRoot: "/factories/acme" },
    "/api/doctor",
  ).then(
    () => null,
    (err: unknown) => err as CliError,
  );
  expect(failure?.message).toContain("http://svc.test:9100");
  expect(failure?.hint).toBe(
    "the acme factory's service is not running — start it: jigs service start",
  );
});
