import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { bindingDir } from "../../steps/worktree/layout.ts";
import {
  makeFactoryRepo,
  makeTmpDir,
  removeTmpDir,
} from "../../test-fixtures.ts";
import { unbindRepo } from "./unbind.ts";

let tmp: string;
let factory: string;

beforeEach(() => {
  tmp = makeTmpDir();
  factory = makeFactoryRepo(tmp);
  writeFileSync(
    path.join(factory, "jigs.yml"),
    `service:
  port: 8990
  dashboard_port: 9090
bindings:
  # api service
  api:
    remote: git@github.com:acme/api.git
  web:
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

test("unbind says the clone stays and where it is", () => {
  const lines: string[] = [];
  unbindRepo("web", { cwd: factory, out: (line) => lines.push(line) });
  expect(lines.some((line) => line.includes("the clone stays at"))).toBe(true);
  expect(
    lines.some((line) =>
      line.includes(bindingDir({ factoryRoot: factory, bindingName: "web" })),
    ),
  ).toBe(true);
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
