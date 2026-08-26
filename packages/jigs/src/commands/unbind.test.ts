import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { unbindRepo } from "./unbind.ts";

let tmp: string;
let factory: string;

beforeEach(() => {
  tmp = makeTmpDir();
  factory = makeFactoryRepo(tmp);
  writeFileSync(
    path.join(factory, "jigs.yml"),
    `bindings:
  # api service
  api:
    path: ~/Code/api
    remote: git@github.com:acme/api.git
  web:
    path: ~/Code/web
    remote: git@github.com:acme/web.git
`,
  );
});
afterEach(() => {
  removeTmpDir(tmp);
});

test("unbind removes the named binding and preserves siblings", () => {
  unbindRepo("web", { cwd: factory, out: () => {} });
  const text = readFileSync(path.join(factory, "jigs.yml"), "utf8");
  expect(text).not.toContain("web:");
  expect(text).toContain("api:");
  expect(text).toContain("# api service");
});

test("unbind of an unknown name lists what is bound", () => {
  expect(() => unbindRepo("nope", { cwd: factory, out: () => {} })).toThrow(
    "no binding named nope",
  );
});

test("unbind outside a factory repo fails with guidance", () => {
  expect(() => unbindRepo("api", { cwd: tmp, out: () => {} })).toThrow(
    "not inside a factory repo",
  );
});
