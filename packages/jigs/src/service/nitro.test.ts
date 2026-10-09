import { expect, test } from "vitest";
import { defineJigsService } from "./nitro.ts";

test("the route serves the Node handler `prepare()` generates", () => {
  expect(defineJigsService().routes?.["/**"]).toEqual({
    handler: "./.jigs/server.ts",
    format: "node",
  });
});

test("the one plugin is the factory's own generated service plugin", () => {
  // It imports the factory's compiled workflows, so it is generated into the
  // factory tree rather than shipped from here.
  expect(defineJigsService().plugins).toEqual(["./.jigs/service.ts"]);
});

test("the optional telemetry import is external, not an unresolved one", () => {
  // Every World the SDK can load imports it optionally; leaving it to
  // rolldown puts a boxed UNRESOLVED_IMPORT on every green build.
  expect(defineJigsService().rolldownConfig?.external).toContain("@opentelemetry/api");
});
