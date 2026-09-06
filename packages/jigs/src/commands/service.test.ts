import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CliError } from "../errors.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { factorySlug } from "../worktrees/layout.ts";
import { resolveServiceTarget, serviceFetch } from "./service.ts";
import { servicePidfilePath } from "./service-lifecycle.ts";

let tmp: string;

beforeEach(() => {
  tmp = makeTmpDir();
  // The unreachable hint reads the pidfile under the data dir.
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
});
afterEach(() => {
  removeTmpDir(tmp);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// The env var reaches this function as `explicit`: commander's `.env()`
// fills the option before the action runs.
test("an explicit --service / JIGS_SERVICE_URL wins over the factory config", () => {
  const factory = makeFactoryRepo(
    tmp,
    "service:\n  port: 9100\n  dashboard_port: 9200\n",
  );
  expect(resolveServiceTarget(factory, "http://elsewhere:1234")).toEqual({
    serviceUrl: "http://elsewhere:1234",
  });
});

test("without an explicit url the factory the user stands in names its service", () => {
  const factory = makeFactoryRepo(
    tmp,
    "service:\n  port: 9100\n  dashboard_port: 9200\n",
  );
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

test("an unreachable service whose pid is alive is booting or wedged, not stopped", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new TypeError("fetch failed")),
  );
  const factory = makeFactoryRepo(
    tmp,
    "service:\n  port: 9100\n  dashboard_port: 9200\n",
  );
  const pidfile = servicePidfilePath(factorySlug(factory));
  mkdirSync(path.dirname(pidfile), { recursive: true });
  writeFileSync(pidfile, `${process.pid}\n`);

  const failure = await serviceFetch(
    { serviceUrl: "http://svc.test:9100", factoryRoot: factory },
    "/api/doctor",
  ).then(
    () => null,
    (err: unknown) => err as CliError,
  );

  expect(failure?.hint).toBe(
    `the ${path.basename(factory)} factory's service is running (pid ${process.pid}) but not answering — still booting, or wedged: jigs service logs`,
  );
});
