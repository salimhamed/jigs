import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { removeBinding, upsertBinding } from "./binding-edit.ts";
import {
  bindingMergePolicy,
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

test("a binding may override either repository-specific merge setting", () => {
  const config = parseFactoryConfig({
    service: { dashboardPort: 9090 },
    bindings: {
      api: { remote: "url", merge: { by: "jigs" } },
      web: { remote: "url", merge: { method: "rebase" } },
    },
    merge: { by: "human", method: "squash", approval: { kind: "review" } },
  });
  const api = config.bindings.api;
  const web = config.bindings.web;
  if (api === undefined || web === undefined) throw new Error("expected both bindings");
  expect(bindingMergePolicy(config.merge, api)).toEqual({
    by: "jigs",
    method: "squash",
    approval: { kind: "review" },
  });
  expect(bindingMergePolicy(config.merge, web)).toEqual({
    by: "human",
    method: "rebase",
    approval: { kind: "review" },
  });
});

test("binding merge approval is rejected as a factory identity policy", () => {
  expect(() =>
    parseFactoryConfig({
      service: { dashboardPort: 9090 },
      bindings: { api: { remote: "url", merge: { approval: { kind: "review" } } } },
    }),
  ).toThrow("approval is factory-level because it follows github.identity");
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
  expect(parseFactoryConfig({ service: { dashboardPort: 3456 } }).service).toEqual({
    port: 8990,
    dashboardPort: 3456,
  });
});

test("identical re-bind preserves every byte", () => {
  expect(upsertBinding(source, "acme-api", "git@github.com:acme/api.git")).toBe(source);
});

test("updating a remote preserves all surrounding text and comments", () => {
  expect(upsertBinding(source, "acme-api", "new-remote")).toBe(
    source.replace("git@github.com:acme/api.git", "new-remote"),
  );
});

test("adding and removing bindings preserves sibling comments and provisioning", () => {
  const added = upsertBinding(source, "other.repo", "git@github.com:acme/other.git");
  expect(readFactoryConfig(factory(added)).bindings["other.repo"]?.remote).toBe(
    "git@github.com:acme/other.git",
  );
  const removed = removeBinding(added, "other.repo");
  expect(removed).toContain("// Main API.");
  expect(removed).toContain("// GitHub");
  expect(readFactoryConfig(factory(removed)).bindings["acme-api"]?.postCreate).toEqual(["npm ci"]);
});

test("adding a binding matches the surrounding formatting", () => {
  const input = `import { defineFactory } from "@salimhamed/jigs";

export default defineFactory({
  bindings: {
    api: { remote: "git@github.com:acme/api.git" },
  },
});
`;
  expect(
    upsertBinding(input, "playground", "git@github.com:acme/pg.git"),
  ).toBe(`import { defineFactory } from "@salimhamed/jigs";

export default defineFactory({
  bindings: {
    api: { remote: "git@github.com:acme/api.git" },
    playground: { remote: "git@github.com:acme/pg.git" },
  },
});
`);
});

test("adding the first binding expands an empty bindings object", () => {
  const input = `export default defineFactory({
  bindings: {},
});
`;
  expect(
    upsertBinding(input, "playground", "git@github.com:acme/pg.git"),
  ).toBe(`export default defineFactory({
  bindings: {
    playground: { remote: "git@github.com:acme/pg.git" },
  },
});
`);
});

test("adding a non-identifier binding keeps its key quoted", () => {
  const input = `export default defineFactory({
  bindings: {
    api: { remote: "git@github.com:acme/api.git" },
  },
});
`;
  expect(
    upsertBinding(input, "other.repo", "git@github.com:acme/other.git"),
  ).toBe(`export default defineFactory({
  bindings: {
    api: { remote: "git@github.com:acme/api.git" },
    "other.repo": { remote: "git@github.com:acme/other.git" },
  },
});
`);
});

test("adding a reserved-word binding keeps its key quoted", () => {
  const input = `export default defineFactory({
  bindings: {},
});
`;
  expect(upsertBinding(input, "import", "git@github.com:acme/import.git")).toBe(
    `export default defineFactory({
  bindings: {
    "import": { remote: "git@github.com:acme/import.git" },
  },
});
`,
  );
});

test("adding a binding to a one-line object does not duplicate the config", () => {
  const input = `export default { bindings: { api: { remote: "a" } } };`;
  expect(upsertBinding(input, "web", "b")).toBe(
    `export default { bindings: { api: { remote: "a" }, web: { remote: "b" }, } };`,
  );
});

test("adding a binding ignores commas in a trailing comment", () => {
  const input = `export default defineFactory({
  bindings: {
    api: { remote: "r1" }
    // api, the main repo
  },
});
`;
  expect(upsertBinding(input, "web", "r2")).toBe(`export default defineFactory({
  bindings: {
    api: { remote: "r1" },
    // api, the main repo
    web: { remote: "r2" },
  },
});
`);
});

test("adding a binding to a one-line object ignores commas in comments", () => {
  const input = `export default { bindings: { api: { remote: "a" } /* one, two */ } };`;
  expect(upsertBinding(input, "web", "b")).toBe(
    `export default { bindings: { api: { remote: "a" }, /* one, two */ web: { remote: "b" }, } };`,
  );
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
  expect(() => upsertBinding(text, "api", "url")).toThrow("Cannot edit bindings in jigs.config.ts");
});

test("config loading supports computed settings without invoking workflow loaders", () => {
  const root = factory(
    `const service = { dashboardPort: 9090 }; export default { service, bindings: { api: { remote: "url" } }, workflows: { ship: () => import("./missing-workflow.ts") } };`,
  );
  expect(resolveService(root).dashboardPort).toBe(9090);
  expect(resolveBinding(root, "api").remote).toBe("url");
});

test("config and imported settings changes are observed in the same process", () => {
  const root = factory(`import service from "./settings.ts"; export default { service };`);
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

const withSettings = (extra: Record<string, unknown>) =>
  parseFactoryConfig({ service: { dashboardPort: 9090 }, ...extra });

test("a factory that states no identity or policy gets the defaults", () => {
  const config = withSettings({});
  expect(config.github.identity).toEqual({ mode: "pat" });
  expect(config.merge).toEqual({
    by: "human",
    method: "squash",
    approval: { kind: "review" },
  });
});

test("an app identity needs every fact a token cannot be minted without", () => {
  const app = {
    mode: "app",
    appId: 4958325,
    installationId: 162033982,
    privateKeyPath: "key.pem",
    operator: "salimhamed",
  };
  expect(withSettings({ github: { identity: app } }).github.identity).toEqual(app);
  for (const missing of ["appId", "installationId", "privateKeyPath", "operator"]) {
    const { [missing as keyof typeof app]: _dropped, ...rest } = app;
    expect(() => withSettings({ github: { identity: rest } })).toThrow(missing);
  }
  // A pat identity carries none of them, so a stray one is a mode that did
  // not change with the fields under it.
  expect(() => withSettings({ github: { identity: { mode: "pat", appId: 1 } } })).toThrow("appId");
});

test("a label approval is nothing without the label's name", () => {
  expect(() => withSettings({ merge: { approval: { kind: "label" } } })).toThrow("name");
  expect(
    withSettings({ merge: { approval: { kind: "label", name: "jigs:approved" } } }).merge.approval,
  ).toEqual({ kind: "label", name: "jigs:approved" });
  // A review approval takes no name, and a signal that is neither is refused.
  expect(() => withSettings({ merge: { approval: { kind: "review", name: "x" } } })).toThrow(
    "name",
  );
  expect(() => withSettings({ merge: { approval: { kind: "comment" } } })).toThrow("approval");
});

test("the merge method is exactly GitHub's three", () => {
  for (const method of ["squash", "merge", "rebase"]) {
    expect(withSettings({ merge: { method } }).merge.method).toBe(method);
  }
  expect(() => withSettings({ merge: { method: "fast-forward" } })).toThrow("method");
});

test("identity and policy are independent: any pairing parses", () => {
  const config = withSettings({
    github: {
      identity: {
        mode: "app",
        appId: 1,
        installationId: 2,
        privateKeyPath: "k.pem",
        operator: "salimhamed",
      },
    },
    merge: { by: "jigs", method: "rebase", approval: { kind: "label", name: "ship-it" } },
  });
  expect(config.github.identity.mode).toBe("app");
  expect(config.merge).toEqual({
    by: "jigs",
    method: "rebase",
    approval: { kind: "label", name: "ship-it" },
  });
});
