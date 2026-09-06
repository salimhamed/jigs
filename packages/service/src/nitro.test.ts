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

test("the dashboard is started after the world it reads, and Slack after both", () => {
  const plugins = defineJigsService().plugins ?? [];
  expect(plugins[0]).toContain("start-world");
  expect(plugins[1]).toContain("start-dashboard");
  expect(plugins[2]).toBe("./.jigs/slack.ts");
});

test("the generated plugins are the factory's own, and come last", () => {
  // Both import the factory's compiled pipelines — the ticker to fire them,
  // the Slack agent to answer about them — so both are generated into the
  // factory tree rather than shipped from here.
  const plugins = defineJigsService().plugins ?? [];
  expect(plugins.slice(2)).toEqual([
    "./.jigs/slack.ts",
    "./.jigs/schedules.ts",
  ]);
});
