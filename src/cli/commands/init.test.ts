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
  installationId: 162033982,
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
      ".npmrc",
      "README.md",
      "docker-compose.yml",
      "jigs.config.test.ts",
      "jigs.config.ts",
      "jigs.ts",
      "nitro.config.ts",
      "package.json",
      "workflows/hello.ts",
      "pnpm-workspace.yaml",
      "tsconfig.json",
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
  expect(pkg.dependencies["@salimhamed/jigs"]).toBe(version);
  expect(Object.keys(pkg.dependencies).filter((name) => name.startsWith("@salimhamed/"))).toEqual([
    "@salimhamed/jigs",
  ]);
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
  expect(workspace).toContain("'@salimhamed/jigs'");
  expect(workspace).not.toContain("minimumReleaseAge:");
  // The scope→registry line only: the token stays in ~/.npmrc.
  const npmrc = readFileSync(path.join(dir, ".npmrc"), "utf8");
  expect(npmrc).toContain("@salimhamed:registry=https://npm.pkg.github.com");
  expect(npmrc).not.toMatch(/^\s*[^#\n]*_authToken/m);
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
  expect(pkg.imports).toEqual({
    "#jigs": "./jigs.ts",
    "#blocks/*": "./blocks/*.ts",
    "#steps/*": "./steps/*.ts",
  });
  for (const target of Object.values(pkg.imports as Record<string, unknown>)) {
    expect(typeof target, String(target)).toBe("string");
    expect(String(target).endsWith(".ts"), String(target)).toBe(true);
  }
  // jigs resolves immediately; factories add blocks/ and steps/ later.
  // A mapping with nothing behind it is
  // inert — nothing resolves it, so nothing complains about it.
  expect(existsSync(path.join(dir, "jigs.ts"))).toBe(true);
  expect(existsSync(path.join(dir, "blocks", "tickets", "linear.ts"))).toBe(false);
  expect(existsSync(path.join(dir, "steps"))).toBe(false);
});

// Both spellings of a relative parent import: `from "../x"` and the dynamic
// `import("../x")` the one deliberate exception in jigs.config.ts uses. A
// pattern matching only the first passes the scaffold for the wrong reason.
const RELATIVE_PARENT_IMPORT = /(?:from|import\s*\()\s*["']\.\.\//;

test("the relative-import guard catches both import spellings", () => {
  expect('import { a } from "../jigs.ts";').toMatch(RELATIVE_PARENT_IMPORT);
  expect('const a = await import("../jigs.ts");').toMatch(RELATIVE_PARENT_IMPORT);
  expect('import { a } from "#jigs";').not.toMatch(RELATIVE_PARENT_IMPORT);
  expect('const a = await import("./workflows/hello.ts");').not.toMatch(RELATIVE_PARENT_IMPORT);
});

// The factory code scaffolded beside the map has to be written in it, or the
// e2e build is the only factory in existence never resolving a # specifier.
test("the scaffolded factory code imports through the root-anchored map", async () => {
  const dir = scaffold("kappa");
  await init(dir);

  const authored = ["workflows/hello.ts"];
  for (const file of authored) {
    const source = readFileSync(path.join(dir, file), "utf8");
    expect(source, file).not.toMatch(RELATIVE_PARENT_IMPORT);
    expect(source, file).toMatch(/["']#(?:jigs|blocks|steps)/);
  }
  // The deferred loaders are registrations rather than import sites, and stay
  // relative on purpose.
  expect(readFileSync(path.join(dir, "jigs.config.ts"), "utf8")).toContain(
    'import("./workflows/hello.ts")',
  );
});

test("the tsconfig compiles the code this factory starts with", async () => {
  const dir = scaffold("epsilon");
  await init(dir);

  const tsconfig = readFileSync(path.join(dir, "tsconfig.json"), "utf8");
  expect(tsconfig).toContain('"steps"');
  expect(tsconfig).toContain('"workflows"');
  expect(tsconfig).toContain('"blocks"');
  expect(tsconfig).toContain('"jigs.ts"');
  expect(tsconfig).toContain('"jigs.config.test.ts"');
});

// Each exported "use step" function's name is half a durable step id, so the
// scaffold's wrappers are the ids every factory's World records. e2e reads
// them back out of a real build and diffs them against e2e/expected-ids.ship.txt;
// here the template is held to that same recorded list without a build.
test("the wrappers scaffolded are the step ids this repo has recorded", async () => {
  const dir = scaffold("theta");
  await init(dir);

  const wrappers = readFileSync(path.join(dir, "jigs.ts"), "utf8");
  const steps = [...wrappers.matchAll(/^export async function (\w+)\(/gm)]
    .map((match) => `step//./jigs//${match[1]}`)
    .sort();
  expect(steps).toHaveLength(27);
  const recorded = readFileSync(path.join(packageRoot(), "e2e", "expected-ids.ship.txt"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("step//./jigs//"))
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
  expect(printed).toContain("jigs.ts is generated");
  expect(printed).toContain("credentials for workflows you add");
  expect(printed).toContain("jigs up --no-doctor");
  expect(printed).toContain("doctor checks GitHub credentials");
  expect(printed).toContain("read:packages");
  expect(printed).toContain("jigs run hello");
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
  expect(pat).toContain('identity: { mode: "pat" }');
  // jigs is the pull request's author under a personal token, and GitHub
  // refuses to let an author approve their own, so a label is the consent.
  expect(pat).toContain('approval: { kind: "label", name: "jigs:approved" }');
  expect(pat).not.toContain('kind: "review"');

  const appFactory = scaffold("app-factory");
  const lines: string[] = [];
  await initFactory({ cwd: appFactory, out: (line) => lines.push(line), identity: APP });
  const app = readFileSync(path.join(appFactory, "jigs.config.ts"), "utf8");
  expect(app).toContain('mode: "app"');
  expect(app).toContain("installationId: 162033982");
  expect(app).toContain('operator: "salimhamed"');
  expect(app).toContain('approval: { kind: "review" }');
  // App mode needs no GITHUB_TOKEN, and does need the key locked down.
  expect(lines.join("\n")).toContain("chmod 600 github-app.private-key.pem");
  expect(lines.join("\n")).toContain("the App needs no GITHUB_TOKEN");
  // The App's private key is a credential, and a scaffolded repo is a git repo.
  expect(readFileSync(path.join(appFactory, ".gitignore"), "utf8")).toContain("*.private-key.pem");
});

// What the scaffolded jigs.config.test.ts asserts, evaluated here: the file
// itself cannot run until the factory installs jigs, and a scaffold whose own
// test is red on day one is the failure this guards.
const scaffoldedExpectations = (dir: string) => {
  const text = readFileSync(path.join(dir, "jigs.config.test.ts"), "utf8");
  const [, github, merge] =
    /expect\(factory\.github\)\.toEqual\((.+?)\);\n\s*expect\(factory\.merge\)\.toEqual\((.+?)\);/s.exec(
      text,
    ) ?? [];
  if (github === undefined || merge === undefined) {
    throw new Error("the scaffolded test no longer asserts the identity and the merge policy");
  }
  return { github: evaluate(github), merge: evaluate(merge) };
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
    merge: unknown;
  };
};

test.each(["pat", "app"] as const)(
  "the %s scaffold's own test asserts what its config declares",
  async (mode) => {
    const dir = scaffold(`${mode}-agreement`);
    await initFactory({
      cwd: dir,
      out: () => {},
      identity: mode === "app" ? APP : { mode: "pat" },
    });
    const expectations = scaffoldedExpectations(dir);
    const config = scaffoldedConfig(dir);
    expect(config.github).toEqual(expectations.github);
    expect(config.merge).toEqual(expectations.merge);
    // And what it declares is what jigs accepts, so the first `jigs up` loads.
    expect(parseFactoryConfig({ service: { dashboardPort: 9090 }, ...config }).github).toEqual(
      expectations.github,
    );
  },
);

test("app mode is refused rather than stubbed when a fact is missing", () => {
  expect(() => resolveIdentityOptions("app", {})).toThrow("--app-id");
  expect(() => resolveIdentityOptions("app", { appId: "1" })).toThrow("--installation-id");
  expect(() =>
    resolveIdentityOptions("app", {
      appId: "0",
      installationId: "2",
      privateKey: "k.pem",
      operator: "salimhamed",
    }),
  ).toThrow("--app-id must be a positive whole number");
  expect(resolveIdentityOptions("pat", {})).toEqual({ mode: "pat" });
  expect(
    resolveIdentityOptions("app", {
      appId: "4958325",
      installationId: "162033982",
      privateKey: "github-app.private-key.pem",
      operator: "salimhamed",
      coAuthor: "Salim Hamed <salim@example.com>",
    }),
  ).toEqual({ ...APP, coAuthor: "Salim Hamed <salim@example.com>" });
});
