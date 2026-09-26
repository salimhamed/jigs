import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { cloneDir } from "../../steps/workspaces/layout.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import { unbindRepo } from "./unbind.ts";

let tmp: string;
let factory: string;

beforeEach(() => {
  tmp = makeTmpDir();
  factory = makeFactoryRepo(tmp);
  writeFileSync(
    path.join(factory, "jigs.config.ts"),
    `export default {
 service: { port: 8990, dashboardPort: 9090 },
 bindings: {
  // api service
  api: { remote: "git@github.com:acme/api.git" },
  web: { remote: "git@github.com:acme/web.git" },
 }, workflows: {},
}`,
  );
});
afterEach(() => {
  removeTmpDir(tmp);
});

test("unbind removes the named binding and preserves siblings", () => {
  unbindRepo("web", { cwd: factory, out: () => {} });
  const text = readFileSync(path.join(factory, "jigs.config.ts"), "utf8");
  expect(text).not.toContain("web:");
  expect(text).toContain("api:");
  expect(text).toContain("// api service");
});

test("unbind says the clone stays and where it is", () => {
  const lines: string[] = [];
  unbindRepo("web", { cwd: factory, out: (line) => lines.push(line) });
  expect(lines.some((line) => line.includes("the clone stays at"))).toBe(true);
  expect(
    lines.some((line) => line.includes(cloneDir({ factoryRoot: factory, bindingName: "web" }))),
  ).toBe(true);
});

test("unbind keeps the binding's files folder and names it", () => {
  const bindingFiles = path.join(factory, "bindings", "web");
  mkdirSync(bindingFiles, { recursive: true });
  writeFileSync(path.join(bindingFiles, ".env"), "SECRET=1\n");
  const lines: string[] = [];

  unbindRepo("web", { cwd: factory, out: (line) => lines.push(line) });

  expect(readFileSync(path.join(bindingFiles, ".env"), "utf8")).toBe("SECRET=1\n");
  expect(lines).toContain(`kept ${bindingFiles} — it may hold secrets, so delete it yourself`);
});

test("unbind without a binding files folder says nothing about one", () => {
  const lines: string[] = [];
  unbindRepo("web", { cwd: factory, out: (line) => lines.push(line) });
  expect(existsSync(path.join(factory, "bindings", "web"))).toBe(false);
  expect(lines.some((line) => line.startsWith("kept "))).toBe(false);
});

test("unbind of an unknown name lists what is bound", () => {
  expect(() => unbindRepo("nope", { cwd: factory, out: () => {} })).toThrow(
    "no binding named nope",
  );
});

test("unbind outside a factory repo fails with guidance", () => {
  expect(() => unbindRepo("api", { cwd: tmp, out: () => {} })).toThrow("not inside a factory repo");
});
