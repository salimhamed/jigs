import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import { listBindings } from "./list-bindings.ts";

let root: string;

const writeBindings = (bindings: object) =>
  writeFileSync(
    path.join(root, "jigs.config.ts"),
    `export default { hub: { url: "https://hub.example.test" }, bindings: ${JSON.stringify(bindings)} };`,
  );

beforeEach(() => {
  root = makeTmpDir();
  vi.spyOn(process, "cwd").mockReturnValue(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  removeTmpDir(root);
});

test("lists every binding with the repository its remote names", () => {
  writeBindings({
    app: { remote: "git@github.com:acme/app.git", installationName: "github-acme" },
    docs: { remote: "https://github.com/acme/docs", installationName: "github-docs" },
  });

  expect(listBindings()).toEqual([
    { name: "app", installationName: "github-acme", owner: "acme", repo: "app" },
    { name: "docs", installationName: "github-docs", owner: "acme", repo: "docs" },
  ]);
});

test("a binding whose remote is not on github.com is left out", () => {
  writeBindings({
    app: { remote: "git@github.com:acme/app.git", installationName: "github-acme" },
    fixtures: { remote: "git@gitlab.com:acme/fixtures.git", installationName: "github-acme" },
  });

  expect(listBindings().map((binding) => binding.name)).toEqual(["app"]);
});
