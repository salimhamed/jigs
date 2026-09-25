import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { parseFactoryConfig } from "../../config/factory-config.ts";
import { packageRoot } from "../templates.ts";
import { initFactory, resolveIdentityOptions } from "./init.ts";

const APP = {
  mode: "app",
  appId: 4958325,
  installations: { salimhamed: 162033982 },
  privateKeyPath: "github-app.private-key.pem",
  operator: "salimhamed",
} as const;

const scaffold = (name: string) => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "jigs-init-")), name);
  return dir;
};

async function init(dir: string) {
  const lines: string[] = [];
  const result = await initFactory({
    cwd: dir,
    out: (line) => lines.push(line),
  });
  return { ...result, lines };
}

test("scaffolds a factory that can be installed and built", async () => {
  const dir = scaffold("acme-factory");
  const { created } = await init(dir);

  // The infrastructure and the code a factory starts from, together: the
  // wrappers and the ids test are what e2e builds, so a scaffold that
  // typechecks and pins its ids is a tested property rather than a hope.
  expect(created.sort()).toEqual(
    [
      ".env.example",
      ".gitignore",
      "README.md",
      "docker-compose.yml",
      "jigs.config.test.ts",
      "jigs.config.ts",
      "jigs/routines.ts",
      "jigs/steps.ts",
      "nitro.config.ts",
      "package.json",
      "workflows/hello/hello.ts",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      "vitest.config.ts",
    ].sort(),
  );
  // The SDK, its World and its dashboard are peers of jigs, loaded by name
  // from the factory's own node_modules, so the factory has to carry them.
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  expect(pkg.dependencies.workflow).toBeDefined();
  expect(pkg.dependencies["@workflow/world-postgres"]).toBeDefined();
  expect(pkg.dependencies["@workflow/web"]).toBeDefined();
  expect(pkg.dependencies.hono).toBeUndefined();
  // The scaffolded ids test needs its runner.
  expect(pkg.devDependencies.vitest).toBeDefined();
  expect(pkg.scripts.test).toBe("vitest run");
  // Pinned to the version of the CLI scaffolding it: a range would let the
  // scaffold's wrappers and the package they import from drift apart.
  const { version } = JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8"));
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.dependencies["@jigs-ai/jigs"]).toBe(version);
  expect(JSON.stringify(pkg)).not.toContain("link:");
  // Spike finding 5: pnpm 11 reads allowBuilds only from pnpm-workspace.yaml.
  const workspace = readFileSync(path.join(dir, "pnpm-workspace.yaml"), "utf8");
  expect(workspace).toContain("@swc/core");
  // A second copy of the SDK or the World fails the install, not the run.
  expect(workspace).toContain("strictPeerDependencies: true");
  // Keeps a factory from installing a Codex CLI it will never run.
  expect(workspace).toContain("ignoredOptionalDependencies");
  expect(workspace).toContain("'@openai/codex'");
  // jigs can upgrade immediately without disabling the operator's age policy
  // for any other package.
  expect(workspace).toContain("minimumReleaseAgeExclude");
  expect(workspace).toContain("'@jigs-ai/jigs'");
  expect(workspace).not.toContain("minimumReleaseAge:");
});

test("every placeholder a template carries is filled in", async () => {
  const dir = scaffold("zeta");
  const { created } = await init(dir);

  for (const file of created) {
    expect(readFileSync(path.join(dir, file), "utf8"), file).not.toMatch(
      /\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/,
    );
  }
});

// Root-anchored specifiers are the factory's own import spelling; the map has
// to mirror the directory layout exactly, because an alias pointing at another
// real file would silently re-address the steps declared in it. Plain string
// targets only: a conditional target keyed on "node" resolves in neither tsc
// nor the workflows bundle, whose esbuild conditions are default, import and
// workflow.
test("the scaffold's imports map mirrors its layout with plain .ts targets", async () => {
  const dir = scaffold("iota");
  await init(dir);

  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  expect(pkg.imports).toEqual({ "#jigs/*": "./jigs/*.ts" });
  for (const target of Object.values(pkg.imports as Record<string, unknown>)) {
    expect(typeof target, String(target)).toBe("string");
    expect(String(target).endsWith(".ts"), String(target)).toBe(true);
  }
  expect(existsSync(path.join(dir, "jigs", "steps.ts"))).toBe(true);
  expect(existsSync(path.join(dir, "jigs", "routines.ts"))).toBe(true);
  expect(existsSync(path.join(dir, "jigs", "index.ts"))).toBe(false);
  expect(existsSync(path.join(dir, "jigs.ts"))).toBe(false);
});

// Both spellings of a relative parent import: `from "../x"` and the dynamic
// `import("../x")` the one deliberate exception in jigs.config.ts uses. A
// pattern matching only the first passes the scaffold for the wrong reason.
const RELATIVE_PARENT_IMPORT = /(?:from|import\s*\()\s*["']\.\.\//;

test("the relative-import guard catches both import spellings", () => {
  expect('import { a } from "../../jigs/steps.ts";').toMatch(RELATIVE_PARENT_IMPORT);
  expect('const a = await import("../../jigs/steps.ts");').toMatch(RELATIVE_PARENT_IMPORT);
  expect('import { a } from "#jigs/steps";').not.toMatch(RELATIVE_PARENT_IMPORT);
  expect('const a = await import("./workflows/hello/hello.ts");').not.toMatch(
    RELATIVE_PARENT_IMPORT,
  );
});

// The factory code scaffolded beside the map has to be written in it, or the
// e2e build is the only factory in existence never resolving a # specifier.
test("the scaffolded factory code imports through the root-anchored map", async () => {
  const dir = scaffold("kappa");
  await init(dir);

  const authored = ["workflows/hello/hello.ts"];
  for (const file of authored) {
    const source = readFileSync(path.join(dir, file), "utf8");
    expect(source, file).not.toMatch(RELATIVE_PARENT_IMPORT);
    expect(source, file).toMatch(/["']#jigs\/(?:steps|routines)["']/);
  }
  // The deferred loaders are registrations rather than import sites, and stay
  // relative on purpose.
  expect(readFileSync(path.join(dir, "jigs.config.ts"), "utf8")).toContain(
    'import("./workflows/hello/hello.ts")',
  );
});

test("the tsconfig compiles the code this factory starts with", async () => {
  const dir = scaffold("epsilon");
  await init(dir);

  const tsconfig = readFileSync(path.join(dir, "tsconfig.json"), "utf8");
  expect(tsconfig).toContain('"workflows"');
  expect(tsconfig).toContain('"jigs"');
  expect(tsconfig).toContain('"jigs.config.test.ts"');
  expect(tsconfig).toContain('"erasableSyntaxOnly": true');
});

// Each exported "use step" function's name is half a durable step id, so the
// scaffold's wrappers are the ids every factory's World records. e2e reads
// them back out of a real build and diffs them against e2e/expected-ids.linear-ticket-to-pr.txt;
// here the template is held to that same recorded list without a build.
test("the wrappers scaffolded are the step ids this repo has recorded", async () => {
  const dir = scaffold("theta");
  await init(dir);

  const wrappers = readFileSync(path.join(dir, "jigs", "steps.ts"), "utf8");
  const steps = [...wrappers.matchAll(/^export async function (\w+)\(/gm)]
    .map((match) => `step//./jigs/steps//${match[1]}`)
    .sort();
  expect(steps).toHaveLength(30);
  const recorded = readFileSync(
    path.join(packageRoot(), "e2e", "expected-ids.linear-ticket-to-pr.txt"),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.startsWith("step//./jigs/steps//"))
    .sort();
  expect(recorded).toEqual(steps);
  // Every wrapper has its directive: one without it compiles clean and runs
  // unmemoized.
  expect(wrappers.match(/"use step";/g)).toHaveLength(steps.length);
});

test("the docker project and ports all carry the factory", async () => {
  const dir = scaffold("alpha");
  const a = await init(dir);

  const compose = readFileSync(path.join(dir, "docker-compose.yml"), "utf8");
  expect(compose).toContain("name: alpha");
  expect(compose).toContain(`"${a.postgresPort}:5432"`);
  const yml = readFileSync(path.join(dir, "jigs.config.ts"), "utf8");
  expect(yml).toContain(`port: ${a.servicePort}`);
  expect(yml).toContain(`dashboardPort: ${a.dashboardPort}`);

  // One offset under 100 shared by three ranges 100 apart, so no factory's
  // service port can be another's dashboard or World port. Two scaffolds
  // landing on different offsets is not the property: the offset is a hash
  // bucket of the path, and any two paths share one about 1% of the time.
  const offset = a.servicePort - 8990;
  expect(offset).toBeGreaterThanOrEqual(0);
  expect(offset).toBeLessThan(100);
  expect(a.dashboardPort).toBe(9090 + offset);
  expect(a.postgresPort).toBe(5440 + offset);

  // Derived from the path, never drawn fresh: jigs up, jigs bind and the
  // committed jigs.config.ts all have to agree with what init printed.
  const again = await init(dir);
  expect(again.created).toEqual([]);
  expect(again.servicePort).toBe(a.servicePort);
  expect(again.dashboardPort).toBe(a.dashboardPort);
  expect(again.postgresPort).toBe(a.postgresPort);

  // A different path is a different derivation, and the project name follows
  // the directory rather than the ports.
  const other = scaffold("beta");
  const b = await init(other);
  expect(readFileSync(path.join(other, "docker-compose.yml"), "utf8")).toContain("name: beta");
  for (const port of [a.servicePort, b.servicePort]) {
    expect(a.dashboardPort).not.toBe(port);
    expect(b.dashboardPort).not.toBe(port);
    expect(a.postgresPort).not.toBe(port);
    expect(b.postgresPort).not.toBe(port);
  }
});

test("an existing file is kept, never overwritten", async () => {
  const dir = scaffold("gamma");
  await init(dir);
  writeFileSync(
    path.join(dir, "jigs.config.ts"),
    "export default { service: { port: 9999 }, workflows: {} };",
  );

  const again = await init(dir);

  expect(again.created).toEqual([]);
  expect(again.skipped).toContain("jigs.config.ts");
  expect(readFileSync(path.join(dir, "jigs.config.ts"), "utf8")).toContain("9999");
});

test("the next steps are printed, not run", async () => {
  const dir = scaffold("delta");
  const { lines } = await init(dir);

  const printed = lines.join("\n");
  const next = lines.indexOf("next, in this directory:");
  // Only the file list and one blank line come before the next steps.
  expect(lines.slice(0, next - 1).every((l) => l.startsWith("created "))).toBe(true);
  expect(lines[next - 1]).toBe("");
  const steps = lines.slice(next + 1).map((l) => l.trim());
  expect(steps.map((l) => l.split("  ")[0])).toEqual([
    "pnpm install",
    "cp .env.example .env",
    "pnpm exec jigs up",
    "pnpm exec jigs run hello",
    "pnpm exec jigs doctor",
  ]);
  expect(printed).not.toContain("--no-doctor");
  // `jigs up` owns the machine-touching commands now, one step at a time.
  expect(printed).not.toContain("docker compose");
  expect(printed).not.toContain("pnpm exec bootstrap");
  // Printing them is the whole point: nothing was executed.
  expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
  expect(existsSync(path.join(dir, ".env"))).toBe(false);
});

test("the scaffold states an identity and the approval signal that matches it", async () => {
  const patFactory = scaffold("pat-factory");
  await init(patFactory);
  const pat = readFileSync(path.join(patFactory, "jigs.config.ts"), "utf8");
  expect(pat).toContain('identities: [{ mode: "pat" }]');
  // jigs is the pull request's author under a personal token, and GitHub
  // refuses to let an author approve their own, so a label is the consent.
  expect(pat).toContain('approval: { kind: "label", name: "jigs:approved" }');
  expect(pat).not.toContain('kind: "review"');

  const appFactory = scaffold("app-factory");
  const lines: string[] = [];
  await initFactory({ cwd: appFactory, out: (line) => lines.push(line), identity: APP });
  const app = readFileSync(path.join(appFactory, "jigs.config.ts"), "utf8");
  expect(app).toContain('mode: "app"');
  expect(app).toContain("installations: { salimhamed: 162033982 }");
  expect(app).toContain('operator: "salimhamed"');
  expect(app).toContain('approval: { kind: "review" }');
  // App mode needs the key locked down.
  expect(lines.join("\n")).toContain("chmod 600 github-app.private-key.pem");
  // The App's private key is a credential, and a scaffolded repo is a git repo.
  expect(readFileSync(path.join(appFactory, ".gitignore"), "utf8")).toContain("*.private-key.pem");
});

// What the scaffolded jigs.config.test.ts asserts, evaluated here: the file
// itself cannot run until the factory installs jigs, and a scaffold whose own
// test is red on day one is the failure this guards.
const scaffoldedExpectations = (dir: string) => {
  const text = readFileSync(path.join(dir, "jigs.config.test.ts"), "utf8");
  const [, github, linear, merge] =
    /expect\(factory\.github\)\.toEqual\((.+?)\);\n\s*expect\(factory\.linear\)\.toEqual\((.+?)\);\n\s*expect\(factory\.merge\)\.toEqual\((.+?)\);/s.exec(
      text,
    ) ?? [];
  if (github === undefined || linear === undefined || merge === undefined) {
    throw new Error("the scaffolded test no longer asserts the identities and the merge policy");
  }
  return { github: evaluate(github), linear: evaluate(linear), merge: evaluate(merge) };
};

// Both files carry settings objects rather than data formats, so both are read
// the same way: as the literal they are.
const evaluate = (literal: string): unknown => new Function(`return ${literal}`)();

// The scaffolded config is TypeScript that imports jigs, so it is read the way
// `jigs bind` reads it: as the settings object, with the wrapper stripped.
const scaffoldedConfig = (dir: string) => {
  const text = readFileSync(path.join(dir, "jigs.config.ts"), "utf8");
  const body = text.slice(
    text.indexOf("defineFactory({") + "defineFactory(".length,
    text.lastIndexOf(")"),
  );
  return evaluate(body.replace(/workflows:\s*\{[^}]*\},?/s, "")) as {
    github: unknown;
    linear: unknown;
    merge: unknown;
  };
};

test.each([
  ["pat", "key"],
  ["app", "app"],
] as const)(
  "the %s/%s scaffold's own test asserts what its config declares",
  async (mode, linearMode) => {
    const dir = scaffold(`${mode}-agreement`);
    await initFactory({
      cwd: dir,
      out: () => {},
      identity: mode === "app" ? APP : { mode: "pat" },
      linearIdentity: { mode: linearMode },
    });
    const expectations = scaffoldedExpectations(dir);
    const config = scaffoldedConfig(dir);
    expect(config.github).toEqual(expectations.github);
    expect(config.linear).toEqual({ identity: { mode: linearMode } });
    expect(config.linear).toEqual(expectations.linear);
    expect(config.merge).toEqual(expectations.merge);
    // And what it declares is what jigs accepts, so the first `jigs up` loads.
    const parsed = parseFactoryConfig({ service: { dashboardPort: 9090 }, ...config });
    expect(parsed.github).toEqual(expectations.github);
    expect(parsed.linear).toEqual(expectations.linear);
  },
);

test("the scaffold names its Linear identity and the variables that mode reads", async () => {
  const keyFactory = scaffold("key-factory");
  await init(keyFactory);
  const key = readFileSync(path.join(keyFactory, "jigs.config.ts"), "utf8");
  expect(key).toContain('identity: { mode: "key" }');
  expect(key).toContain("LINEAR_API_KEY");

  const appFactory = scaffold("linear-app-factory");
  await initFactory({ cwd: appFactory, out: () => {}, linearIdentity: { mode: "app" } });
  const app = readFileSync(path.join(appFactory, "jigs.config.ts"), "utf8");
  expect(app).toContain('identity: { mode: "app" }');
  expect(app).toContain("LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET");
  // Both modes' slots are scaffolded, so switching mode needs no new .env line.
  const example = readFileSync(path.join(appFactory, ".env.example"), "utf8");
  for (const name of ["LINEAR_API_KEY=", "LINEAR_CLIENT_ID=", "LINEAR_CLIENT_SECRET="])
    expect(example).toContain(name);
});

test("app mode is refused rather than stubbed when a fact is missing", () => {
  expect(() => resolveIdentityOptions("app", {})).toThrow("--github-app-id");
  expect(() => resolveIdentityOptions("app", { githubAppId: "1" })).toThrow(
    "--github-app-installation",
  );
  expect(() =>
    resolveIdentityOptions("app", {
      githubAppId: "0",
      githubAppInstallation: ["salimhamed=2"],
      githubAppPrivateKeyPath: "k.pem",
      githubOperatorLogin: "salimhamed",
    }),
  ).toThrow("--github-app-id must be a positive whole number");
  expect(resolveIdentityOptions("pat", {})).toEqual({ mode: "pat" });
  expect(
    resolveIdentityOptions("app", {
      githubAppId: "4958325",
      githubAppInstallation: ["salimhamed=162033982"],
      githubAppPrivateKeyPath: "github-app.private-key.pem",
      githubOperatorLogin: "salimhamed",
      gitCoAuthor: "Salim Hamed <salim@example.com>",
    }),
  ).toEqual({ ...APP, coAuthor: "Salim Hamed <salim@example.com>" });
});

test("repeatable installations scaffold a loadable account map", async () => {
  const options = {
    githubAppId: "1",
    githubAppPrivateKeyPath: "app.pem",
    githubOperatorLogin: "human",
    githubAppInstallation: ["some-org=10", "Other=20"],
  };
  const identity = resolveIdentityOptions("app", options);
  expect(identity).toMatchObject({ installations: { "some-org": 10, Other: 20 } });
  const dir = scaffold("installation-map");
  await initFactory({ cwd: dir, out: () => {}, identity });
  expect(
    parseFactoryConfig({ service: { dashboardPort: 9090 }, ...scaffoldedConfig(dir) }).github
      .identities,
  ).toEqual([identity]);
  expect(() =>
    resolveIdentityOptions("app", { ...options, githubAppInstallation: ["Other=1", "other=2"] }),
  ).toThrow("duplicate");
  expect(() =>
    resolveIdentityOptions("app", { ...options, githubAppInstallation: ["bad"] }),
  ).toThrow("<account>=<id>");
});
