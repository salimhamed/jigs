import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { removeBinding, upsertBinding } from "./binding-edit.ts";
import {
  parseFactoryConfig,
  readFactoryConfig,
  resolveBinding,
  resolveService,
} from "./factory-config.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeTmpDir(root);
});
function factory(source: string) {
  const root = makeTmpDir();
  roots.push(root);
  writeFileSync(path.join(root, "jigs.config.ts"), source);
  return root;
}
const source = `// Factory config.
export default {
  service: { port: 8990, dashboardPort: 9090 },
  bindings: {
    // Main API.
    "acme-api": {
      remote: "git@github.com:acme/api.git", // GitHub
      postCreate: ["npm ci"],
    },
  },
  workflows: {},
};
`;

test("binding defaults and declared provisioning are validated", () => {
  const config = readFactoryConfig(factory(source));
  expect(config.bindings["acme-api"]).toEqual({
    remote: "git@github.com:acme/api.git",
    copy: [],
    postCreate: ["npm ci"],
    hookTimeoutMinutes: 10,
  });
});

test.each([
  [{ service: {} }, "dashboardPort"],
  [{ service: { dashboardPort: 0 } }, "dashboardPort"],
  [{ service: { dashboardPort: 9090, port: 70000 } }, "port"],
  [{ service: { dashboardPort: 9090 }, bindings: { api: {} } }, "remote"],
  [
    {
      service: { dashboardPort: 9090 },
      bindings: { api: { remote: "url", hookTimeoutMinutes: 0 } },
    },
    "hookTimeoutMinutes",
  ],
  [
    {
      service: { dashboardPort: 9090 },
      bindings: { api: { remote: "url", typo: true } },
    },
    "typo",
  ],
])("invalid configuration names its field", (value, field) => {
  expect(() => parseFactoryConfig(value)).toThrow(field);
});

test("service port defaults while dashboard port is explicit", () => {
  expect(
    parseFactoryConfig({ service: { dashboardPort: 3456 } }).service,
  ).toEqual({ port: 8990, dashboardPort: 3456 });
});

test("identical re-bind preserves every byte", () => {
  expect(upsertBinding(source, "acme-api", "git@github.com:acme/api.git")).toBe(
    source,
  );
});

test("updating a remote preserves all surrounding text and comments", () => {
  expect(upsertBinding(source, "acme-api", "new-remote")).toBe(
    source.replace("git@github.com:acme/api.git", "new-remote"),
  );
});

test("adding and removing bindings preserves sibling comments and provisioning", () => {
  const added = upsertBinding(
    source,
    "other.repo",
    "git@github.com:acme/other.git",
  );
  expect(readFactoryConfig(factory(added)).bindings["other.repo"]?.remote).toBe(
    "git@github.com:acme/other.git",
  );
  const removed = removeBinding(added, "other.repo");
  expect(removed).toContain("// Main API.");
  expect(removed).toContain("// GitHub");
  expect(
    readFactoryConfig(factory(removed)).bindings["acme-api"]?.postCreate,
  ).toEqual(["npm ci"]);
});

test("missing bindings object is inserted", () => {
  const edited = upsertBinding(
    "export default { service: { dashboardPort: 9090 } };",
    "api",
    "url",
  );
  expect(readFactoryConfig(factory(edited)).bindings.api?.remote).toBe("url");
});

test.each([
  "export default defineFactory({ bindings: getBindings() });",
  "export default defineFactory({ ...config, bindings: {} });",
  "export default defineFactory({ bindings: {}, ...config });",
  "export default defineFactory({ bindings: {}, bindings: {} });",
  "export default defineFactory({ bindings: { ...other } });",
  "export default defineFactory({ bindings: { [key]: {} } });",
  "export default defineFactory({ bindings: { api: imported } });",
  "export default defineFactory({ bindings: { api: { ...other } } });",
  "export default config;",
  "export default defineFactory({ bindings: { api: { remote: url } } });",
])("unsupported automatic edits fail clearly", (text) => {
  expect(() => upsertBinding(text, "api", "url")).toThrow(
    "Cannot edit bindings in jigs.config.ts",
  );
});

test("config loading supports computed settings without invoking workflow loaders", () => {
  const root = factory(
    `const service = { dashboardPort: 9090 }; export default { service, bindings: { api: { remote: "url" } }, workflows: { ship: () => import("./missing-workflow.ts") } };`,
  );
  expect(resolveService(root).dashboardPort).toBe(9090);
  expect(resolveBinding(root, "api").remote).toBe("url");
});

test("config and imported settings changes are observed in the same process", () => {
  const root = factory(
    `import service from "./settings.ts"; export default { service };`,
  );
  const settings = path.join(root, "settings.ts");
  writeFileSync(settings, "export default { dashboardPort: 9090 };");
  expect(resolveService(root).dashboardPort).toBe(9090);
  writeFileSync(settings, "export default { dashboardPort: 9091 };");
  expect(resolveService(root).dashboardPort).toBe(9091);
  writeFileSync(
    path.join(root, "jigs.config.ts"),
    "export default { service: { dashboardPort: 9092 } };",
  );
  expect(resolveService(root).dashboardPort).toBe(9092);
});
