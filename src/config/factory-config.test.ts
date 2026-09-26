import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { defineFactory } from "../workflow/factory.ts";
import { addWorkflow, removeBinding, upsertBinding } from "./config-edit.ts";
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
    mergeMethod: "squash",
    copy: [],
    postCreate: ["npm ci"],
    hookTimeoutMinutes: 10,
  });
});

test("a binding's merge method is exactly GitHub's three", () => {
  for (const mergeMethod of ["squash", "merge", "rebase"]) {
    const config = withSettings({ bindings: { api: { remote: "url", mergeMethod } } });
    expect(config.bindings.api?.mergeMethod).toBe(mergeMethod);
  }
  expect(() =>
    withSettings({ bindings: { api: { remote: "url", mergeMethod: "fast-forward" } } }),
  ).toThrow("mergeMethod");
});

test("defineFactory accepts a binding merge method", () => {
  const definition = defineFactory({
    service: { dashboardPort: 9090 },
    bindings: { api: { remote: "url", mergeMethod: "rebase" } },
    workflows: {},
  });
  expect(definition.bindings.api.mergeMethod).toBe("rebase");
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
  [{ service: { dashboardPort: 9090, pollIntervalSeconds: { github: 29 } } }, "github"],
  [{ service: { dashboardPort: 9090, pollIntervalSeconds: { linear: 1.5 } } }, "linear"],
  [{ service: { dashboardPort: 9090 }, webhooks: { github: { enabled: true } } }, "url"],
  [
    {
      service: { dashboardPort: 9090 },
      webhooks: { url: "https://f.test", github: { enabled: true } },
    },
    "linear",
  ],
  [
    {
      service: { dashboardPort: 9090 },
      webhooks: { url: "https://f.test", github: {}, linear: { enabled: false } },
    },
    "enabled",
  ],
  [
    {
      service: { dashboardPort: 9090 },
      webhooks: { url: "not a url", github: { enabled: true }, linear: { enabled: false } },
    },
    "url",
  ],
])("invalid configuration names its field", (value, field) => {
  expect(() => parseFactoryConfig(value)).toThrow(field);
});

test("service port defaults while dashboard port is explicit", () => {
  expect(parseFactoryConfig({ service: { dashboardPort: 3456 } }).service).toEqual({
    port: 8990,
    dashboardPort: 3456,
    pollIntervalSeconds: { github: 300, linear: 300 },
  });
});

test("each provider's poll interval defaults on its own and may sit at the floor", () => {
  expect(
    parseFactoryConfig({ service: { dashboardPort: 3456, pollIntervalSeconds: { linear: 30 } } })
      .service.pollIntervalSeconds,
  ).toEqual({ github: 300, linear: 30 });
});

test("without a webhooks section no provider sends webhooks", () => {
  expect(parseFactoryConfig({ service: { dashboardPort: 3456 } }).webhooks).toBeUndefined();
});

test("agent environment names default to none and must be names, not values", () => {
  expect(parseFactoryConfig({ service: { dashboardPort: 3456 } }).agents).toEqual({ env: [] });
  expect(
    parseFactoryConfig({ service: { dashboardPort: 3456 }, agents: { env: ["MISE_DATA_DIR"] } })
      .agents.env,
  ).toEqual(["MISE_DATA_DIR"]);
  expect(() =>
    parseFactoryConfig({ service: { dashboardPort: 3456 }, agents: { env: ["A=b"] } }),
  ).toThrow("agents.env.0");
  expect(() =>
    defineFactory({ service: { dashboardPort: 3456 }, agents: { env: ["A=b"] }, workflows: {} }),
  ).toThrow("agents.env.0");
});

test.each([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "CODEX_HOME",
  "PI_CODING_AGENT_DIR",
  "CLAUDE_CONFIG_DIR",
])("agents.env rejects %s, which jigs sets or which selects a model credential", (name) => {
  const definition = { service: { dashboardPort: 3456 }, agents: { env: [name] }, workflows: {} };
  expect(() => parseFactoryConfig(definition)).toThrow("model source");
  expect(() => defineFactory(definition)).toThrow("model source");
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
  const input = `import { defineFactory } from "@jigs-ai/jigs";

export default defineFactory({
  bindings: {
    api: { remote: "git@github.com:acme/api.git" },
  },
});
`;
  expect(
    upsertBinding(input, "playground", "git@github.com:acme/pg.git"),
  ).toBe(`import { defineFactory } from "@jigs-ai/jigs";

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

test("adding a binding preserves a trailing comma before a comment", () => {
  const input = `export default defineFactory({
  bindings: {
    api: { remote: "r1" },
    // note, with comma
  },
});
`;
  expect(upsertBinding(input, "web", "r2")).toBe(`export default defineFactory({
  bindings: {
    api: { remote: "r1" },
    // note, with comma
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

test.each([
  [
    "export default defineFactory({ workflows: {} });",
    'workflows: {\n  ship: () => import("./workflows/ship/ship.ts"),\n}',
  ],
  ["export default defineFactory({ workflows: { hello } });", undefined],
])("a workflow is registered in a direct workflows object", (text, expected) => {
  if (expected) expect(addWorkflow(text, "ship")).toContain(expected);
  else expect(() => addWorkflow(text, "ship")).toThrow("Cannot register ship");
});

test("an already registered workflow leaves the config alone", () => {
  expect(
    addWorkflow('export default { workflows: { ship: () => import("./x.ts") } };', "ship"),
  ).toBeUndefined();
  expect(() => addWorkflow("export default {};", "ship")).toThrow(
    "Cannot register ship in jigs.config.ts: workflows is not a direct object",
  );
});

test("config loading supports computed settings without invoking workflow loaders", () => {
  const root = factory(
    `const service = { dashboardPort: 9090 }; export default { service, bindings: { api: { remote: "url" } }, workflows: { ship: () => import("./missing-workflow.ts") } };`,
  );
  expect(resolveService(root).dashboardPort).toBe(9090);
  expect(resolveBinding(root, "api").remote).toBe("url");
});

test("native TypeScript config is one snapshot per process and a new process sees edits", () => {
  const root = factory(`import service from "./settings.ts"; export default { service };`);
  const settings = path.join(root, "settings.ts");
  writeFileSync(
    settings,
    "const service: { dashboardPort: number } = { dashboardPort: 9090 }; export default service;",
  );
  expect(resolveService(root).dashboardPort).toBe(9090);
  writeFileSync(settings, "export default { dashboardPort: 9091 };");
  expect(resolveService(root).dashboardPort).toBe(9090);

  const moduleUrl = pathToFileURL(
    fileURLToPath(new URL("./factory-config.ts", import.meta.url)),
  ).href;
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { readFactoryConfig } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(readFactoryConfig(process.argv[1])));`,
      root,
    ],
    { encoding: "utf8" },
  );
  expect(JSON.parse(output).service.dashboardPort).toBe(9091);
});

const withSettings = (extra: Record<string, unknown>) =>
  parseFactoryConfig({ service: { dashboardPort: 9090 }, ...extra });

test("a factory that states no identity gets a PAT, approved by label", () => {
  const config = withSettings({});
  expect(config.github).toEqual({ identities: [{ mode: "pat" }], mergeApproval: "label" });
});

test("an app identity needs every fact a token cannot be minted without", () => {
  const app = {
    mode: "app",
    appId: 4958325,
    installations: { salimhamed: 162033982 },
    privateKeyPath: "key.pem",
    operator: "salimhamed",
  };
  expect(withSettings({ github: { identities: [app] } }).github.identities[0]).toEqual(app);
  for (const missing of ["appId", "installations", "privateKeyPath", "operator"]) {
    const { [missing as keyof typeof app]: _dropped, ...rest } = app;
    expect(() => withSettings({ github: { identities: [rest] } })).toThrow(missing);
  }
  // A pat identity carries none of them, so a stray one is a mode that did
  // not change with the fields under it.
  expect(() => withSettings({ github: { identities: [{ mode: "pat", appId: 1 }] } })).toThrow(
    "appId",
  );
});

test("a factory that states no Linear identity acts with a personal key", () => {
  expect(withSettings({}).linear).toEqual({ identity: { mode: "key" } });
  expect(withSettings({ linear: {} }).linear).toEqual({ identity: { mode: "key" } });
});

test("a Linear identity is key or app and carries nothing else", () => {
  for (const mode of ["key", "app"]) {
    expect(withSettings({ linear: { identity: { mode } } }).linear.identity).toEqual({ mode });
  }
  expect(() => withSettings({ linear: { identity: { mode: "pat" } } })).toThrow("linear.identity");
  // Secrets live in .env, so a client id in config is refused, not ignored.
  expect(() => withSettings({ linear: { identity: { mode: "app", clientId: "abc" } } })).toThrow(
    "clientId",
  );
  expect(() => withSettings({ linear: { identities: [{ mode: "key" }] } })).toThrow("identities");
});

test("a Linear operator is optional and must be an email", () => {
  expect(withSettings({ linear: { operator: "salim@example.com" } }).linear).toEqual({
    identity: { mode: "key" },
    operator: "salim@example.com",
  });
  expect(withSettings({ linear: {} }).linear.operator).toBeUndefined();
  expect(() => withSettings({ linear: { operator: "salim" } })).toThrow("linear.operator");
  expect(() => withSettings({ linear: { operator: "" } })).toThrow("linear.operator");
});

const APP_IDENTITY = {
  mode: "app",
  appId: 1,
  installations: { owner: 2 },
  privateKeyPath: "k.pem",
  operator: "salimhamed",
};

test("merge approval defaults to review for an App, and an App may choose the label", () => {
  expect(withSettings({ github: { identities: [APP_IDENTITY] } }).github.mergeApproval).toBe(
    "review",
  );
  expect(
    withSettings({ github: { identities: [APP_IDENTITY], mergeApproval: "label" } }).github
      .mergeApproval,
  ).toBe("label");
  expect(() => withSettings({ github: { mergeApproval: "comment" } })).toThrow("mergeApproval");
});

test("a PAT cannot approve by review, because GitHub refuses an author's own approval", () => {
  expect(withSettings({ github: { mergeApproval: "label" } }).github.mergeApproval).toBe("label");
  expect(() => withSettings({ github: { mergeApproval: "review" } })).toThrow(
    "GitHub does not let the author of a pull request approve it",
  );
});

test("App maps and lists normalize and reject ambiguous account ownership", async () => {
  const { installationFor } = await import("./factory-config.ts");
  const app = {
    mode: "app",
    appId: 1,
    privateKeyPath: "key.pem",
    operator: "human",
    installations: { Junglescout: 10 },
  };
  const config = withSettings({ github: { identities: [app] } });
  expect(installationFor(config.github.identities, "junglescout")).toMatchObject({
    appId: 1,
    installationId: 10,
  });
  expect(installationFor(config.github.identities, "junglescout")).not.toHaveProperty(
    "installations",
  );
  const identities = [app, { ...app, appId: 2, installations: { Other: 20 } }];
  expect(withSettings({ github: { identities } }).github.identities).toEqual(identities);
  expect(() =>
    withSettings({ github: { identities: [app, { ...app, installations: { JUNGLESCOUT: 30 } }] } }),
  ).toThrow("claimed more than once");
  expect(() => withSettings({ github: { identities: [{ ...app, installations: {} }] } })).toThrow(
    "must not be empty",
  );
  expect(() => withSettings({ github: { identities: [{ ...app, installationId: 20 }] } })).toThrow(
    "installationId",
  );
  expect(() => withSettings({ github: { identity: app } })).toThrow("identity");
  expect(withSettings({ github: { identities: [{ mode: "pat" }] } }).github.identities).toEqual([
    { mode: "pat" },
  ]);
  expect(() => withSettings({ github: { identities: [{ mode: "pat" }, app] } })).toThrow(
    "PAT must be the only identity",
  );
  expect(() =>
    withSettings({ github: { identities: [{ mode: "pat" }, { mode: "pat" }] } }),
  ).toThrow("PAT must be the only identity");
  expect(() => withSettings({ github: { identities: [] } })).toThrow("github.identities");
});
