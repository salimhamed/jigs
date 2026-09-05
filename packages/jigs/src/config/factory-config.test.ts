import { expect, test } from "vitest";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { factorySlug } from "../worktrees/layout.ts";
import {
  parseFactoryConfig,
  removeBinding,
  resolveService,
  upsertBinding,
} from "./factory-config.ts";

// The dashboard port has no default, so every config that has to parse at all
// carries a service block.
const SERVICE = "service:\n  port: 8990\n  dashboard_port: 9090\n";

const commented = `# Factory repo config.
${SERVICE}bindings:
  # The main API service.
  acme-api:
    remote: git@github.com:acme/api.git # the one on GitHub
`;

test("upsertBinding creates the bindings block in a file without one", () => {
  const text = upsertBinding(
    SERVICE,
    "acme-api",
    "git@github.com:acme/api.git",
  );
  expect(parseFactoryConfig(text).bindings["acme-api"]).toEqual({
    remote: "git@github.com:acme/api.git",
  });
});

test("upsertBinding preserves comments on existing entries", () => {
  const text = upsertBinding(
    commented,
    "acme-web",
    "git@github.com:acme/web.git",
  );
  expect(text).toContain("# Factory repo config.");
  expect(text).toContain("# The main API service.");
  expect(text).toContain("# the one on GitHub");
  expect(parseFactoryConfig(text).bindings["acme-web"]?.remote).toBe(
    "git@github.com:acme/web.git",
  );
});

test("re-upsert with identical values is byte-identical", () => {
  const text = upsertBinding(
    commented,
    "acme-api",
    "git@github.com:acme/api.git",
  );
  expect(text).toBe(commented);
});

test("upsertBinding re-pins the remote in place, comment kept", () => {
  const text = upsertBinding(
    commented,
    "acme-api",
    "git@github.com:acme/api-moved.git",
  );
  expect(parseFactoryConfig(text).bindings["acme-api"]?.remote).toBe(
    "git@github.com:acme/api-moved.git",
  );
  expect(text).toContain("# the one on GitHub");
});

test("removeBinding removes one entry and preserves siblings' comments", () => {
  const two = upsertBinding(
    commented,
    "acme-web",
    "git@github.com:acme/web.git",
  );
  const text = removeBinding(two, "acme-web");
  expect(text).toContain("# The main API service.");
  expect(text).toContain("acme-api");
  expect(text).not.toContain("acme-web");
});

test("removeBinding on an unknown name lists bound names", () => {
  expect(() => removeBinding(commented, "nope")).toThrow(
    "no binding named nope",
  );
});

test("parseFactoryConfig rejects unknown per-binding keys naming the key", () => {
  const text = `${SERVICE}bindings:
  acme-api:
    remote: git@github.com:acme/api.git
    harness: claude
`;
  expect(() => parseFactoryConfig(text)).toThrow(/harness/);
});

// The loud failure a factory still carrying the old binding shape wants.
test("parseFactoryConfig rejects a binding declaring a local path", () => {
  const text = `${SERVICE}bindings:
  acme-api:
    path: ~/Code/acme-api
    remote: git@github.com:acme/api.git
`;
  expect(() => parseFactoryConfig(text)).toThrow(/path/);
});

test("parseFactoryConfig rejects a binding with no remote", () => {
  expect(() =>
    parseFactoryConfig(`${SERVICE}bindings:\n  acme-api: {}\n`),
  ).toThrow(/remote/);
});

test("parseFactoryConfig tolerates unknown top-level keys", () => {
  expect(parseFactoryConfig(`pipelines: {}\n${SERVICE}`).bindings).toEqual({});
});

test("the service port defaults to the one the single global service used", () => {
  const config = parseFactoryConfig("service:\n  dashboard_port: 9090\n");
  expect(config.service).toEqual({ port: 8990, dashboard_port: 9090 });
});

test("parseFactoryConfig rejects an out-of-range port naming the field", () => {
  expect(() =>
    parseFactoryConfig("service:\n  port: 70000\n  dashboard_port: 9090\n"),
  ).toThrow(/service\.port/);
});

test("parseFactoryConfig rejects an out-of-range dashboard port the same way", () => {
  expect(() =>
    parseFactoryConfig("service:\n  port: 9100\n  dashboard_port: 0\n"),
  ).toThrow(/service\.dashboard_port/);
});

test("a config with no dashboard port refuses to parse, naming the field", () => {
  // No default on purpose: any number jigs picked would be some other
  // factory's service port, and this one is the operator's to choose.
  expect(() => parseFactoryConfig("service:\n  port: 9100\n")).toThrow(
    /service\.dashboard_port/,
  );
  expect(() => parseFactoryConfig("")).toThrow(/service\.dashboard_port/);
});

test("the dashboard port is read as written, never derived from the port", () => {
  const config = parseFactoryConfig(
    "service:\n  port: 9100\n  dashboard_port: 3456\n",
  );
  expect(config.service.dashboard_port).toBe(3456);
});

test("resolveService derives the service address and the slug", () => {
  const tmp = makeTmpDir();
  try {
    const factory = makeFactoryRepo(
      tmp,
      "service:\n  port: 9100\n  dashboard_port: 9200\n",
    );
    expect(resolveService(factory)).toEqual({
      slug: factorySlug(factory),
      port: 9100,
      serviceUrl: "http://localhost:9100",
      dashboardPort: 9200,
      dashboardUrl: "http://localhost:9200",
    });
  } finally {
    removeTmpDir(tmp);
  }
});
