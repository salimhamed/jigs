import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { defineJigsService } from "./nitro.ts";

test("the plugins this package ships resolve to files that exist", () => {
  // Nitro resolves a bare plugins entry against the build root, which for a
  // factory repo is the factory. A wrong path here fails at build time in
  // someone else's repo and nowhere in this one. The generated ones are
  // relative and belong to the factory, so absoluteness is what tells the two
  // kinds apart.
  const shipped = (defineJigsService().plugins ?? []).filter((plugin) =>
    path.isAbsolute(plugin as string),
  );
  expect(shipped).toHaveLength(2);
  for (const plugin of shipped) {
    expect(existsSync(plugin as string)).toBe(true);
  }
});

test("the route serves the entry `prepare()` generates", () => {
  expect(defineJigsService().routes?.["/**"]).toBe("./.jigs/server.ts");
});

test("the dashboard is started after the world it reads", () => {
  const plugins = defineJigsService().plugins ?? [];
  expect(plugins[0]).toContain("start-world");
  expect(plugins[1]).toContain("start-dashboard");
});

test("the schedules plugin is the factory's own, and comes last", () => {
  // It imports the factory's compiled pipelines, so it is generated into the
  // factory tree rather than shipped from here.
  expect(defineJigsService().plugins?.[2]).toBe("./.jigs/schedules.ts");
});

test("the optional telemetry import is external, not an unresolved one", () => {
  // Every World the SDK can load imports it optionally; leaving it to
  // rolldown puts a boxed UNRESOLVED_IMPORT on every green build.
  expect(defineJigsService().rolldownConfig?.external).toContain(
    "@opentelemetry/api",
  );
});
