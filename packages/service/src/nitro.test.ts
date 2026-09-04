import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { defineJigsService } from "./nitro.ts";

test("the start-world plugin resolves to a file that exists", () => {
  // Nitro resolves a bare plugins entry against the build root, which for a
  // factory repo is the factory. A wrong path here fails at build time in
  // someone else's repo and nowhere in this one.
  const plugin = defineJigsService().plugins?.[0] as string;
  expect(path.isAbsolute(plugin)).toBe(true);
  expect(existsSync(plugin)).toBe(true);
});

test("the route serves the entry `prepare()` generates", () => {
  expect(defineJigsService().routes?.["/**"]).toBe("./.jigs/server.ts");
});

test("the schedules plugin is the factory's own, and comes after the world's", () => {
  // It imports the factory's compiled pipelines, so it is generated into the
  // factory tree rather than shipped from here.
  expect(defineJigsService().plugins?.[1]).toBe("./.jigs/schedules.ts");
});
