import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { defineFactory } from "../workflow/factory.ts";
import { parseFactoryConfig } from "../workflow/factory-schema.ts";
import { addWorkflow, removeBinding, upsertBinding } from "./config-edit.ts";
import { readFactoryConfig, resolveBinding, resolveService } from "./factory-config.ts";
import { resolveFactoryContext } from "./factory-context.ts";

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
  hub: { url: "https://hub.example.test" }, service: { port: 8990, dashboardPort: 9090 },
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

test("an unknown top-level section is rejected by name", () => {
  expect(() => withSettings({ lienar: { identity: { mode: "app" } } })).toThrow(
    /\(root\): Unrecognized key: "lienar"/,
  );
});

test("defineFactory rejects an unknown top-level section at compile time and when loaded", () => {
  expect(() =>
    defineFactory({
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 9090 },
      workflows: {},
      // @ts-expect-error lienar is not a factory section
      lienar: {},
    }),
  ).toThrow(/\(root\): Unrecognized key: "lienar"/);
});

test.each([
  [{ service: {} }, "dashboardPort"],
  [{ hub: { url: "https://hub.example.test" }, service: { dashboardPort: 0 } }, "dashboardPort"],
  [
    { hub: { url: "https://hub.example.test" }, service: { dashboardPort: 9090, port: 70000 } },
    "port",
  ],
  [
    {
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 9090 },
      bindings: { api: {} },
    },
    "remote",
  ],
  [
    {
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 9090 },
      bindings: { api: { remote: "url", hookTimeoutMinutes: 0 } },
    },
    "hookTimeoutMinutes",
  ],
  [
    {
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 9090 },
      bindings: { api: { remote: "url", typo: true } },
    },
    "typo",
  ],
  [
    {
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 9090, pollIntervalSeconds: { github: 300 } },
    },
    "github",
  ],
  [{ service: { dashboardPort: 9090 } }, "hub"],
  [{ hub: { url: "hub.example.test" }, service: { dashboardPort: 9090 } }, "url"],
  [
    {
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 9090, pollIntervalSeconds: { linear: 1.5 } },
    },
    "linear",
  ],
  [
    {
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 9090, pollIntervalSeconds: { slack: 10 } },
    },
    "slack",
  ],
  [
    {
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 9090 },
      slack: { socketMode: true },
    },
    '"socketMode"',
  ],
  [
    {
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 9090, pollIntervalSeconds: { pagerduty: 10 } },
    },
    "pagerduty",
  ],
])("invalid configuration names its field", (value, field) => {
  expect(() => parseFactoryConfig(value)).toThrow(field);
});

test("service port defaults while dashboard port is explicit", () => {
  expect(
    parseFactoryConfig({
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 3456 },
    }).service,
  ).toEqual({
    port: 8990,
    dashboardPort: 3456,
    pollIntervalSeconds: { linear: 300, slack: 300, pagerduty: 300 },
  });
});

test("each provider's poll interval defaults on its own and may sit at the floor", () => {
  expect(
    parseFactoryConfig({
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 3456, pollIntervalSeconds: { linear: 30 } },
    }).service.pollIntervalSeconds,
  ).toEqual({ linear: 30, slack: 300, pagerduty: 300 });
});

test("without a slack section the factory has no Slack app", () => {
  expect(
    parseFactoryConfig({
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 3456 },
    }).slack,
  ).toBeUndefined();
  expect(
    parseFactoryConfig({
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 3456 },
      slack: {},
    }).slack,
  ).toEqual({ scopes: [] });
});

test("agent environment names default to none and must be names, not values", () => {
  expect(
    parseFactoryConfig({
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 3456 },
    }).agents,
  ).toEqual({ env: [] });
  expect(
    parseFactoryConfig({
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 3456 },
      agents: { env: ["MISE_DATA_DIR"] },
    }).agents.env,
  ).toEqual(["MISE_DATA_DIR"]);
  expect(() =>
    parseFactoryConfig({
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 3456 },
      agents: { env: ["A=b"] },
    }),
  ).toThrow("agents.env.0");
  expect(() =>
    defineFactory({
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 3456 },
      agents: { env: ["A=b"] },
      workflows: {},
    }),
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
  const definition = {
    hub: { url: "https://hub.example.test" },
    service: { dashboardPort: 3456 },
    agents: { env: [name] },
    workflows: {},
  };
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
    "export default { hub: { url: 'https://hub.example.test' }, service: { dashboardPort: 9090 } };",
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
    `const service = { dashboardPort: 9090 }; export default { hub: { url: "https://hub.example.test" }, service, bindings: { api: { remote: "url" } }, workflows: { ship: () => import("./missing-workflow.ts") } };`,
  );
  const ctx = resolveFactoryContext(root);
  expect(resolveService(ctx).dashboardPort).toBe(9090);
  expect(resolveBinding(ctx.config, "api").remote).toBe("url");
});

test("native TypeScript config is one snapshot per process and a new process sees edits", () => {
  const root = factory(
    `import service from "./settings.ts"; export default { hub: { url: "https://hub.example.test" }, service };`,
  );
  const settings = path.join(root, "settings.ts");
  writeFileSync(
    settings,
    "const service: { dashboardPort: number } = { dashboardPort: 9090 }; export default service;",
  );
  expect(resolveService(resolveFactoryContext(root)).dashboardPort).toBe(9090);
  writeFileSync(settings, "export default { dashboardPort: 9091 };");
  expect(resolveService(resolveFactoryContext(root)).dashboardPort).toBe(9090);

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
  parseFactoryConfig({
    hub: { url: "https://hub.example.test" },
    service: { dashboardPort: 9090 },
    ...extra,
  });

test("a factory that states no GitHub settings names no operator and approves by review", () => {
  expect(withSettings({}).github).toEqual({ mergeApproval: "review" });
});

test("the GitHub section holds the operator, co-author and approval, and no identity", () => {
  const github = {
    operator: "salimhamed",
    coAuthor: "Salim <s@example.com>",
    mergeApproval: "label",
  };
  expect(withSettings({ github }).github).toEqual(github);
  expect(() => withSettings({ github: { mergeApproval: "comment" } })).toThrow("mergeApproval");
  expect(() => withSettings({ github: { identities: [{ mode: "pat" }] } })).toThrow("identities");
});

test("a Linear operator is optional and must be an email", () => {
  expect(withSettings({ linear: { operator: "salim@example.com" } }).linear).toEqual({
    operator: "salim@example.com",
  });
  expect(withSettings({}).linear).toEqual({});
  expect(() => withSettings({ linear: { identity: { mode: "key" } } })).toThrow("identity");
  expect(withSettings({ linear: {} }).linear.operator).toBeUndefined();
  expect(() => withSettings({ linear: { operator: "salim" } })).toThrow("linear.operator");
  expect(() => withSettings({ linear: { operator: "" } })).toThrow("linear.operator");
});

test("a factory without a pagerduty section has no PagerDuty settings", () => {
  expect(withSettings({}).pagerduty).toBeUndefined();
});

test("a PagerDuty section names the from user by email, and nothing else", () => {
  expect(withSettings({ pagerduty: { from: "oncall@example.com" } }).pagerduty).toEqual({
    from: "oncall@example.com",
  });
  for (const from of ["oncall", ""]) {
    expect(() => withSettings({ pagerduty: { from } })).toThrow("pagerduty.from");
  }
  expect(() => withSettings({ pagerduty: {} })).toThrow("pagerduty.from");
  expect(() =>
    withSettings({ pagerduty: { from: "oncall@example.com", identity: { mode: "app" } } }),
  ).toThrow("identity");
});

const sweep = { sweep: () => Promise.reject(new Error("never loaded")) };
const pages = {
  workflow: "sweep",
  source: { kind: "pagerduty.incidents", params: {} },
};
const configError = (extra: Record<string, unknown>): string => {
  try {
    withSettings({ workflows: sweep, ...extra });
  } catch (error) {
    return String(error);
  }
  throw new Error("the config loaded");
};

test("a schedule naming a workflow this factory does not have fails to load", () => {
  expect(
    configError({ schedules: { nightly: { workflow: "swep", cron: "0 3 * * *", inputs: {} } } }),
  ).toContain(
    'schedules.nightly.workflow: workflow "swep" is not one of this factory\'s workflows\n' +
      "    set schedules.nightly.workflow in jigs.config.ts to one of: sweep",
  );
});

test("a schedule or trigger name carrying a colon fails to load — it would answer for another", () => {
  expect(
    configError({
      schedules: { "nightly:sweep": { workflow: "sweep", cron: "0 3 * * *", inputs: {} } },
    }),
  ).toContain(
    'schedules.nightly:sweep: schedule name "nightly:sweep" contains ":"\n' +
      '    rename the "nightly:sweep" schedule in jigs.config.ts to a name without ":"',
  );
  expect(configError({ triggers: { "pages:x": pages } })).toContain(
    'trigger name "pages:x" contains ":"',
  );
});

test("a trigger with an unknown workflow or a bad cap fails to load, naming each", () => {
  const error = configError({
    triggers: {
      wrong: { ...pages, workflow: "respnd" },
      capped: { ...pages, maxActive: 0 },
      lookback: { ...pages, lookbackMinutes: -1 },
    },
  });
  expect(error).toContain('workflow "respnd" is not one of this factory\'s workflows');
  expect(error).toContain(
    "triggers.capped.maxActive: maxActive 0 is not a whole number of at least 1",
  );
  expect(error).toContain(
    "triggers.lookback.lookbackMinutes: lookbackMinutes -1 is not a positive number of minutes",
  );
});

test("workflows, schedules and triggers are checked for shape when the config loads", () => {
  expect(configError({ workflows: { sweep: "./sweep.ts" } })).toContain(
    "workflows.sweep: must be a deferred import",
  );
  expect(
    configError({ schedules: { nightly: { workflow: "sweep", cron: "0 3 * * *" } } }),
  ).toContain("schedules.nightly.inputs");
  expect(configError({ triggers: { pages: { ...pages, maxActiv: 3 } } })).toContain(
    'Unrecognized key: "maxActiv"',
  );
});

test("defineFactory refuses a schedule naming a workflow it does not declare", () => {
  expect(() =>
    defineFactory({
      hub: { url: "https://hub.example.test" },
      service: { dashboardPort: 9090 },
      workflows: sweep,
      schedules: { nightly: { workflow: "swep", cron: "0 3 * * *", inputs: {} } },
    }),
  ).toThrow('workflow "swep" is not one of this factory\'s workflows');
});

test("valid schedules and triggers load as declared", () => {
  const config = withSettings({
    workflows: sweep,
    schedules: { nightly: { workflow: "sweep", cron: "0 3 * * *", inputs: { target: "a" } } },
    triggers: { pages: { ...pages, maxActive: 3 } },
  });
  expect(config.triggers).toEqual({ pages: { ...pages, maxActive: 3 } });
});
