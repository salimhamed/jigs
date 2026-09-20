import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { parse } from "yaml";
import {
  apiEntries,
  convert,
  hasPackageDocumentation,
  internalReferences,
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
        "./blocks/agents": {
          types: "./dist/blocks/agents/index.d.ts",
          default: "./dist/blocks/agents/index.js",
        },
      },
    },
    { index: "src/index.ts", "blocks/agents/index": "src/blocks/agents/index.ts" },
  );
  expect(entries).toEqual([
    { subpath: ".", source: "src/index.ts", output: "index.md" },
    {
      subpath: "./blocks/agents",
      source: "src/blocks/agents/index.ts",
      output: "blocks/agents.md",
    },
  ]);
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
    intentionallyNotDocumented: [],
    tsconfig: fileURLToPath(new URL("fixtures/tsconfig.json", import.meta.url)),
    validation: { ...typedocOptions.validation, notDocumented: false },
  });
  expect(app.logger.warningCount).toBeGreaterThanOrEqual(3);
});

test("TypeDoc rejects stale intentionally-not-documented entries", async () => {
  const fixture = fileURLToPath(new URL("fixtures/restricted-tags.ts", import.meta.url));
  const { app, project } = await convert([fixture], {
    blockTags: ["@param", "@returns", "@mystery"],
    intentionallyNotDocumented: ["does.not.exist"],
    tsconfig: fileURLToPath(new URL("fixtures/tsconfig.json", import.meta.url)),
    validation: { ...typedocOptions.validation, notDocumented: true },
  });
  app.logger.resetWarnings();
  app.validate(project);
  expect(app.logger.validationWarningCount).toBe(1);
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
  const { version } = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  expect(firstPage).toContain(`@salimhamed/jigs v${version}`);
  expect(firstPage).toContain('Wrap steps in a factory-owned `"use step"` file.');
  expect(firstPage).not.toContain("Defined in:");
  expect(firstPage).toBe(secondPage);
}, 20_000);

test("the release branch generates docs without waiting on the merge job", async () => {
  const workflow = parse(
    await readFile(path.join(rootDir, ".github/workflows/release.yml"), "utf8"),
  );
  expect(workflow.on.push.branches).toContain("release-please--branches--main");
  expect(workflow.concurrency.group).toContain("github.ref");

  const docsJob = workflow.jobs["api-docs"];
  expect(docsJob.needs).toBeUndefined();
  expect(docsJob.if).toContain("release-please--branches--main");
  const serialized = JSON.stringify(docsJob);
  expect(serialized).toContain("RELEASE_PLEASE_TOKEN");
  const generateStep = docsJob.steps.find((step) => step.run?.includes("docs"));
  expect(generateStep?.run).toBe("pnpm run docs");
  expect(serialized).toContain("git diff --cached --quiet");
  expect(serialized).toContain("git add -f docs/api");

  const mergeStep = workflow.jobs["release-please"].steps.find(
    (step) => step.name === "Merge the release PR",
  );
  expect(mergeStep.env.EXPECTED_CHECKS.split(" ")).toContain("api-docs");
});
