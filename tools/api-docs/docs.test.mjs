import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { parse } from "yaml";
import {
  apiEntries,
  assertDirectExportSummaries,
  convert,
  directExportSummaryFailures,
  factoryEntries,
  hasPackageDocumentation,
  internalReferences,
  isPublicEntry,
  packageDir,
  publicSidebar,
  renderEntry,
  rootDir,
} from "./docs.mjs";
import { typedocOptions } from "./typedoc.config.mjs";

const temporary = [];

afterAll(async () => {
  await Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jigs-api-docs-test-"));
  temporary.push(directory);
  return directory;
}

test("package exports determine the API reference layout", () => {
  const entries = apiEntries(
    {
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./steps/agents": {
          types: "./dist/steps/agents/index.d.ts",
          default: "./dist/steps/agents/index.js",
        },
      },
    },
    { index: "src/index.ts", "steps/agents/index": "src/steps/agents/index.ts" },
  );
  expect(entries).toEqual([
    { subpath: ".", source: "src/index.ts", output: "index.md" },
    {
      subpath: "./steps/agents",
      source: "src/steps/agents/index.ts",
      output: "steps/agents.md",
    },
  ]);
});

test("public package docs exclude service plumbing and the empty human module", () => {
  const published = [".", "./steps/agents", "./steps/linear"];
  const service = ["./steps/human", "./nitro", "./build", "./service", "./routines"];
  expect(published.every((subpath) => isPublicEntry({ subpath }))).toBe(true);
  expect(service.some((subpath) => isPublicEntry({ subpath }))).toBe(false);
});

test("the comment gate reads only doc comments and rejects internal references", () => {
  const source = `
// ADR 0014 is valid in a maintainer comment.
/** Public prose must not cite AGE-418 or docs/adr/0014-release-automation.md. */
`;
  expect(internalReferences(source, "example.ts")).toEqual([
    'example.ts:3: doc comment contains Linear ticket "AGE-418"',
    'example.ts:3: doc comment contains ADR path "docs/adr/0014-release-automation.md"',
  ]);
  expect(hasPackageDocumentation("/** Summary.\n * @packageDocumentation\n */\nexport {};")).toBe(
    true,
  );
  expect(hasPackageDocumentation("// @packageDocumentation\nexport {};")).toBe(false);
  expect(
    hasPackageDocumentation("/** Symbol docs. */\n/** @packageDocumentation */\nexport {};"),
  ).toBe(false);
});

test("TypeDoc rejects parameter, return and unknown block tags", async () => {
  const fixture = fileURLToPath(new URL("fixtures/restricted-tags.ts", import.meta.url));
  const { app } = await convert([fixture], {
    tsconfig: fileURLToPath(new URL("fixtures/tsconfig.json", import.meta.url)),
    validation: typedocOptions.validation,
  });
  expect(app.logger.warningCount).toBeGreaterThanOrEqual(3);
});

test("the summary gate checks direct exports but not their nested members", async () => {
  const fixture = fileURLToPath(new URL("fixtures/direct-export-summary.ts", import.meta.url));
  const { project } = await convert([fixture], {
    tsconfig: fileURLToPath(new URL("fixtures/tsconfig.json", import.meta.url)),
    validation: typedocOptions.validation,
  });
  expect(directExportSummaryFailures(project)).toEqual(["@jigs-ai/jigs.undocumentedDirectExport"]);
  expect(() => assertDirectExportSummaries(project)).toThrow(
    "Direct exports missing a summary:\n- @jigs-ai/jigs.undocumentedDirectExport",
  );
});

test("the real renderer writes stable subpath pages with the package version", async () => {
  const first = await tempDir();
  const second = await tempDir();
  const entry = {
    subpath: "./steps/human",
    source: "src/steps/human/index.ts",
    output: "steps/human.md",
  };
  await renderEntry(entry, first);
  await renderEntry(entry, second);

  expect(await readdir(first, { recursive: true })).toEqual(["steps", "steps/human.md"]);
  const firstPage = await readFile(path.join(first, entry.output), "utf8");
  const secondPage = await readFile(path.join(second, entry.output), "utf8");
  const { version } = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  expect(firstPage).toContain(`@jigs-ai/jigs v${version}`);
  expect(firstPage).toContain('Wrap steps in a factory-owned `"use step"` file.');
  expect(firstPage).not.toContain("Defined in:");
  const root = await tempDir();
  await renderEntry({ subpath: ".", source: "src/index.ts", output: "index.md" }, root);
  const rootPage = await readFile(path.join(root, "index.md"), "utf8");
  expect(rootPage).toContain("### JigsError");
  expect(rootPage).toContain("##### hint?");
  expect(rootPage).not.toContain("captureStackTrace");
  expect(firstPage).toBe(secondPage);
}, 60_000);

test("factory references expose caller signatures and concrete bound options", async () => {
  const destination = await tempDir();
  for (const entry of factoryEntries) {
    assertDirectExportSummaries(await renderEntry(entry, destination));
  }
  const routines = await readFile(path.join(destination, "factory/routines.md"), "utf8");
  const steps = await readFile(path.join(destination, "factory/steps.md"), "utf8");
  for (const name of ["runAgent", "haltForHuman", "watchPullRequest", "committedWork"]) {
    expect(routines).toContain(`### ${name}()`);
  }
  for (const field of ["scope", "since", "body"]) {
    expect(routines).toContain(`###### ${field}`);
  }
  for (const internal of ["HaltForHumanFn", "StepFields", "ExecuteAgentStep"]) {
    expect(routines).not.toContain(internal);
  }
  expect(routines).toContain("### postPullRequestNote()");
  expect(routines).not.toContain("pullRequestGate");
  expect(steps).not.toContain("branchContains");
  expect(routines).toContain("Only one run may watch");
  expect(steps).toContain("### createRunDirectory()");
  expect(steps).toContain("### release()");
  expect(steps).not.toContain("RunMetadata");
}, 60_000);

test("API navigation labels generated imports and low-level implementations separately", () => {
  const sidebar = publicSidebar([
    { subpath: "." },
    { subpath: "./steps" },
    { subpath: "./steps/git" },
    { subpath: "./steps/human" },
  ]);
  expect(sidebar.map((item) => item.text)).toEqual([
    "jigs",
    "Factory routines",
    "Factory steps",
    "Custom agent step APIs",
    "Step implementations",
  ]);
  expect(sidebar.at(-1).items).toEqual([{ text: "git", link: "/api/steps/git" }]);
});

test("the publish job generates the reference from the tag, and nothing commits it", async () => {
  const release = parse(
    await readFile(path.join(rootDir, ".github/workflows/release.yml"), "utf8"),
  );
  expect(release.on.push.branches).toEqual(["main"]);

  const steps = release.jobs.publish.steps.map((step) => step.run ?? step.uses);
  const docs = steps.indexOf("pnpm run docs");
  expect(docs).toBeGreaterThan(-1);
  expect(docs).toBeLessThan(steps.findIndex((run) => run?.includes("npm publish")));

  const workflows = await Promise.all(
    ["release.yml", "ci.yml"].map((name) =>
      readFile(path.join(rootDir, ".github/workflows", name), "utf8"),
    ),
  );
  for (const workflow of workflows) expect(workflow).not.toContain("git add -f docs/api");
});
