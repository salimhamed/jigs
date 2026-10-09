import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { makeTmpDir, removeTmpDir, testFactoryContext } from "../test-fixtures.ts";
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
  hub: { url: "https://hub.example.test" },
  bindings: {
    // Main API.
    "acme-api": {
      remote: "git@github.com:acme/api.git", // GitHub
      installationName: "gh",
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
    installationName: "gh",
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
      workflows: {},
      // @ts-expect-error lienar is not a factory section
      lienar: {},
    }),
  ).toThrow(/\(root\): Unrecognized key: "lienar"/);
});

test.each([
  [
    {
      hub: { url: "https://hub.example.test" },
      bindings: { api: {} },
    },
    "remote",
  ],
  [
    {
      hub: { url: "https://hub.example.test" },
      bindings: { api: { remote: "url", installationName: "gh", hookTimeoutMinutes: 0 } },
    },
    "hookTimeoutMinutes",
  ],
  [
    {
      hub: { url: "https://hub.example.test" },
      bindings: { api: { remote: "url", installationName: "gh", typo: true } },
    },
    "typo",
  ],
  [
    {
      hub: { url: "https://hub.example.test" },
      bindings: { api: { remote: "url" } },
    },
    "bindings.api.installationName",
  ],
  [
    {
      hub: { url: "https://hub.example.test" },
      bindings: { api: { remote: "url", installationName: "Acme_GitHub" } },
    },
    "must be an installation name from the hub",
  ],
  [{ hub: { url: "hub.example.test" } }, "url"],
  [
    {
      hub: { url: "https://hub.example.test" },
      slack: { scopes: [] },
    },
    'Unrecognized key: "slack"',
  ],
  [
    {
      hub: { url: "https://hub.example.test" },
      pagerduty: { from: "oncall@example.com" },
    },
    'Unrecognized key: "pagerduty"',
  ],
  [
    {
      hub: { url: "https://hub.example.test" },
      service: { port: 8990 },
    },
    'Unrecognized key: "service"',
  ],
])("invalid configuration names its field", (value, field) => {
  expect(() => parseFactoryConfig(value)).toThrow(field);
});

test("the service's ports come from the environment", () => {
  const ctx = testFactoryContext({
    env: { JIGS_SERVICE_PORT: "7001", JIGS_DASHBOARD_PORT: "7002" },
  });
  expect(resolveService(ctx)).toMatchObject({
    serviceUrl: "http://localhost:7001",
    dashboardUrl: "http://localhost:7002",
  });
});

test.each(["JIGS_SERVICE_PORT", "JIGS_DASHBOARD_PORT"])("an unset %s fails by name", (name) => {
  const env = { JIGS_SERVICE_PORT: "7001", JIGS_DASHBOARD_PORT: "7002", [name]: "" };
  expect(() => resolveService(testFactoryContext({ env }))).toThrow(`${name} is not set`);
});

test("agent environment names default to none and must be names, not values", () => {
  expect(
    parseFactoryConfig({
      hub: { url: "https://hub.example.test" },
    }).agents,
  ).toEqual({ env: [] });
  expect(
    parseFactoryConfig({
      hub: { url: "https://hub.example.test" },
      agents: { env: ["MISE_DATA_DIR"] },
    }).agents.env,
  ).toEqual(["MISE_DATA_DIR"]);
  expect(() =>
    parseFactoryConfig({
      hub: { url: "https://hub.example.test" },
      agents: { env: ["A=b"] },
    }),
  ).toThrow("agents.env.0");
  expect(() =>
    defineFactory({
      hub: { url: "https://hub.example.test" },
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
    agents: { env: [name] },
    workflows: {},
  };
  expect(() => parseFactoryConfig(definition)).toThrow("model source");
  expect(() => defineFactory(definition)).toThrow("model source");
});

test("identical re-bind preserves every byte", () => {
  expect(
    upsertBinding(source, "acme-api", {
      remote: "git@github.com:acme/api.git",
      installationName: "gh",
    }),
  ).toBe(source);
});

test("updating an installation name preserves all surrounding text and comments", () => {
  expect(
    upsertBinding(source, "acme-api", {
      remote: "git@github.com:acme/api.git",
      installationName: "other",
    }),
  ).toBe(source.replace('installationName: "gh"', 'installationName: "other"'));
});

test("a binding without an installation name gains one beside its remote", () => {
  const input = `export default {
  hub: { url: "https://hub.example.test" },
  bindings: {
    // Main API.
    api: {
      remote: "a",
    },
  },
};
`;
  const edited = upsertBinding(input, "api", { remote: "a", installationName: "gh" });
  expect(edited).toContain("// Main API.");
  expect(readFactoryConfig(factory(edited)).bindings.api).toMatchObject({
    remote: "a",
    installationName: "gh",
  });
});

test("updating a remote preserves all surrounding text and comments", () => {
  expect(upsertBinding(source, "acme-api", { remote: "new-remote", installationName: "gh" })).toBe(
    source.replace("git@github.com:acme/api.git", "new-remote"),
  );
});

test("adding and removing bindings preserves sibling comments and provisioning", () => {
  const added = upsertBinding(source, "other.repo", {
    remote: "git@github.com:acme/other.git",
    installationName: "gh",
  });
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
    upsertBinding(input, "playground", {
      remote: "git@github.com:acme/pg.git",
      installationName: "gh",
    }),
  ).toBe(`import { defineFactory } from "@jigs-ai/jigs";

export default defineFactory({
  bindings: {
    api: { remote: "git@github.com:acme/api.git" },
    playground: { remote: "git@github.com:acme/pg.git", installationName: "gh" },
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
    upsertBinding(input, "playground", {
      remote: "git@github.com:acme/pg.git",
      installationName: "gh",
    }),
  ).toBe(`export default defineFactory({
  bindings: {
    playground: { remote: "git@github.com:acme/pg.git", installationName: "gh" },
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
    upsertBinding(input, "other.repo", {
      remote: "git@github.com:acme/other.git",
      installationName: "gh",
    }),
  ).toBe(`export default defineFactory({
  bindings: {
    api: { remote: "git@github.com:acme/api.git" },
    "other.repo": { remote: "git@github.com:acme/other.git", installationName: "gh" },
  },
});
`);
});

test("adding a reserved-word binding keeps its key quoted", () => {
  const input = `export default defineFactory({
  bindings: {},
});
`;
  expect(
    upsertBinding(input, "import", {
      remote: "git@github.com:acme/import.git",
      installationName: "gh",
    }),
  ).toBe(
    `export default defineFactory({
  bindings: {
    "import": { remote: "git@github.com:acme/import.git", installationName: "gh" },
  },
});
`,
  );
});

test("adding a binding to a one-line object does not duplicate the config", () => {
  const input = `export default { bindings: { api: { remote: "a" } } };`;
  expect(upsertBinding(input, "web", { remote: "b", installationName: "gh" })).toBe(
    `export default { bindings: { api: { remote: "a" }, web: { remote: "b", installationName: "gh" }, } };`,
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
  expect(
    upsertBinding(input, "web", { remote: "r2", installationName: "gh" }),
  ).toBe(`export default defineFactory({
  bindings: {
    api: { remote: "r1" },
    // api, the main repo
    web: { remote: "r2", installationName: "gh" },
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
  expect(
    upsertBinding(input, "web", { remote: "r2", installationName: "gh" }),
  ).toBe(`export default defineFactory({
  bindings: {
    api: { remote: "r1" },
    // note, with comma
    web: { remote: "r2", installationName: "gh" },
  },
});
`);
});

test("adding a binding to a one-line object ignores commas in comments", () => {
  const input = `export default { bindings: { api: { remote: "a" } /* one, two */ } };`;
  expect(upsertBinding(input, "web", { remote: "b", installationName: "gh" })).toBe(
    `export default { bindings: { api: { remote: "a" }, /* one, two */ web: { remote: "b", installationName: "gh" }, } };`,
  );
});

test("missing bindings object is inserted", () => {
  const edited = upsertBinding(
    "export default { hub: { url: 'https://hub.example.test' } };",
    "api",
    { remote: "url", installationName: "gh" },
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
  expect(() => upsertBinding(text, "api", { remote: "url", installationName: "gh" })).toThrow(
    "Cannot edit bindings in jigs.config.ts",
  );
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
    `const github = { operator: "octo" }; export default { hub: { url: "https://hub.example.test" }, github, bindings: { api: { remote: "url", installationName: "gh" } }, workflows: { ship: () => import("./missing-workflow.ts") } };`,
  );
  const ctx = resolveFactoryContext(root);
  expect(ctx.config.github.operator).toBe("octo");
  expect(resolveBinding(ctx.config, "api").remote).toBe("url");
});

test("native TypeScript config is one snapshot per process and a new process sees edits", () => {
  const root = factory(
    `import github from "./settings.ts"; export default { hub: { url: "https://hub.example.test" }, github };`,
  );
  const settings = path.join(root, "settings.ts");
  writeFileSync(
    settings,
    'const github: { operator: string } = { operator: "first" }; export default github;',
  );
  expect(resolveFactoryContext(root).config.github.operator).toBe("first");
  writeFileSync(settings, 'export default { operator: "second" };');
  expect(resolveFactoryContext(root).config.github.operator).toBe("first");

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
  expect(JSON.parse(output).github.operator).toBe("second");
});

const withSettings = (extra: Record<string, unknown>) =>
  parseFactoryConfig({
    hub: { url: "https://hub.example.test" },
    ...extra,
  });

test("a factory that states no GitHub settings names no operator and approves by review", () => {
  expect(withSettings({}).github).toEqual({ mergeApproval: "review" });
});

test("the GitHub section holds the operator, co-author and approval", () => {
  const github = {
    operator: "salimhamed",
    coAuthor: "Salim <s@example.com>",
    mergeApproval: "label",
  };
  expect(withSettings({ github }).github).toEqual(github);
  expect(() => withSettings({ github: { mergeApproval: "comment" } })).toThrow("mergeApproval");
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

const sweep = { sweep: () => Promise.reject(new Error("never loaded")) };
const pages = {
  active: true,
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
    configError({
      schedules: { nightly: { active: true, workflow: "swep", cron: "0 3 * * *", inputs: {} } },
    }),
  ).toContain(
    'schedules.nightly.workflow: workflow "swep" is not one of this factory\'s workflows\n' +
      "    set schedules.nightly.workflow in jigs.config.ts to one of: sweep",
  );
});

test("a schedule or trigger name carrying a colon fails to load — it would answer for another", () => {
  expect(
    configError({
      schedules: {
        "nightly:sweep": { active: true, workflow: "sweep", cron: "0 3 * * *", inputs: {} },
      },
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
    configError({ schedules: { nightly: { active: true, workflow: "sweep", cron: "0 3 * * *" } } }),
  ).toContain("schedules.nightly.inputs");
  expect(configError({ triggers: { pages: { ...pages, active: undefined } } })).toContain(
    "triggers.pages.active",
  );
  expect(configError({ triggers: { pages: { ...pages, maxActiv: 3 } } })).toContain(
    'Unrecognized key: "maxActiv"',
  );
});

test("defineFactory refuses a schedule naming a workflow it does not declare", () => {
  expect(() =>
    defineFactory({
      hub: { url: "https://hub.example.test" },
      workflows: sweep,
      schedules: { nightly: { active: true, workflow: "swep", cron: "0 3 * * *", inputs: {} } },
    }),
  ).toThrow('workflow "swep" is not one of this factory\'s workflows');
});

test("valid schedules and triggers load as declared", () => {
  const config = withSettings({
    workflows: sweep,
    schedules: {
      nightly: { active: true, workflow: "sweep", cron: "0 3 * * *", inputs: { target: "a" } },
    },
    triggers: { pages: { ...pages, maxActive: 3 } },
  });
  expect(config.triggers).toEqual({ pages: { ...pages, maxActive: 3 } });
});
