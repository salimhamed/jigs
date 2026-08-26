import { expect, test } from "vitest";
import {
  parseFactoryConfig,
  removeBinding,
  upsertBinding,
} from "./factory-config.ts";

const commented = `# Factory repo config.
bindings:
  # The main API service.
  acme-api:
    path: ~/Code/acme-api # local checkout
    remote: git@github.com:acme/api.git
`;

test("upsertBinding creates the bindings block in an empty file", () => {
  const text = upsertBinding("", "acme-api", {
    path: "~/Code/acme-api",
    remote: "git@github.com:acme/api.git",
  });
  expect(parseFactoryConfig(text).bindings["acme-api"]).toMatchObject({
    path: "~/Code/acme-api",
    remote: "git@github.com:acme/api.git",
  });
});

test("upsertBinding preserves comments on existing entries", () => {
  const text = upsertBinding(commented, "acme-web", {
    path: "~/Code/acme-web",
    remote: "git@github.com:acme/web.git",
  });
  expect(text).toContain("# Factory repo config.");
  expect(text).toContain("# The main API service.");
  expect(text).toContain("# local checkout");
  expect(parseFactoryConfig(text).bindings["acme-web"]?.remote).toBe(
    "git@github.com:acme/web.git",
  );
});

test("re-upsert with identical values is byte-identical", () => {
  const text = upsertBinding(commented, "acme-api", {
    path: "~/Code/acme-api",
    remote: "git@github.com:acme/api.git",
  });
  expect(text).toBe(commented);
});

test("upsertBinding re-pins the remote without touching other fields", () => {
  const withExtras = `bindings:
  acme-api:
    path: ~/Code/acme-api
    remote: git@github.com:acme/api.git
    workspace_dir: ~/Code/acme-api-worktrees
    ff_default_branch: false
`;
  const text = upsertBinding(withExtras, "acme-api", {
    path: "~/Code/acme-api",
    remote: "git@github.com:acme/api-moved.git",
  });
  const binding = parseFactoryConfig(text).bindings["acme-api"];
  expect(binding?.remote).toBe("git@github.com:acme/api-moved.git");
  expect(binding?.workspace_dir).toBe("~/Code/acme-api-worktrees");
  expect(binding?.ff_default_branch).toBe(false);
});

test("removeBinding removes one entry and preserves siblings' comments", () => {
  const two = upsertBinding(commented, "acme-web", {
    path: "~/Code/acme-web",
    remote: "git@github.com:acme/web.git",
  });
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
  const text = `bindings:
  acme-api:
    path: ~/Code/acme-api
    remote: git@github.com:acme/api.git
    harness: claude
`;
  expect(() => parseFactoryConfig(text)).toThrow(/harness/);
});

test("parseFactoryConfig rejects a binding missing required fields", () => {
  expect(() =>
    parseFactoryConfig("bindings:\n  acme-api:\n    path: ~/x\n"),
  ).toThrow(/remote/);
});

test("ff_default_branch defaults to true", () => {
  const config = parseFactoryConfig(commented);
  expect(config.bindings["acme-api"]?.ff_default_branch).toBe(true);
});

test("parseFactoryConfig tolerates unknown top-level keys and empty files", () => {
  expect(parseFactoryConfig("").bindings).toEqual({});
  expect(parseFactoryConfig("pipelines: {}\n").bindings).toEqual({});
});
