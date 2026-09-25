import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  hasPackageDocumentation,
  internalReferences,
  isPublicEntry,
  publicSidebar,
  renderEntry,
  rootDir,
  withFactoryEntries,
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
  const service = [
    "./steps/human",
    "./app",
    "./nitro",
    "./build",
    "./schedules",
    "./plugins/start-world",
    "./routines",
  ];
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
  const { version } = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
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
  let temporarySource;
  await withFactoryEntries(async ({ entries, tsconfig }) => {
    temporarySource = entries[0].source;
    const { project } = await convert(
      entries.map((entry) => entry.source),
      { tsconfig },
    );
    assertDirectExportSummaries(project);
    for (const entry of entries) await renderEntry(entry, destination, { tsconfig });
  });
  await expect(readFile(temporarySource)).rejects.toMatchObject({ code: "ENOENT" });
  const routines = await readFile(path.join(destination, "factory/routines.md"), "utf8");
  const steps = await readFile(path.join(destination, "factory/steps.md"), "utf8");
  for (const name of ["runAgent", "haltForHuman", "watchPullRequest", "committedWork"]) {
    expect(routines).toContain(`### ${name}()`);
  }
  for (const field of ["scope", "since", "body", "threads", "answers"]) {
    expect(routines).toContain(`###### ${field}`);
  }
  for (const internal of [
    "HaltForHumanFn",
    "BoundReviewTicketOptions",
    "StepFields",
    "ExecuteAgentStep",
  ]) {
    expect(routines).not.toContain(internal);
  }
  expect(routines).toContain("### pullRequestGate()");
  expect(routines).toContain("Only one run may own");
  expect(steps).toContain("### createRunDirectory()");
  expect(steps).toContain("### release()");
  expect(steps).not.toContain("RunMetadata");
  expect(steps).not.toContain("FactoryDefinition");
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

test("release docs generate independently while GitHub gates auto-merge", async () => {
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
    (step) => step.name === "Enable auto-merge for the release PR",
  );
  expect(mergeStep.env.GH_TOKEN).toContain("RELEASE_PLEASE_TOKEN");
  expect(mergeStep.run).toContain("gh pr list --head release-please--branches--main");
  expect(mergeStep.run).toContain('gh pr merge "$pr" --auto --squash');
  expect(mergeStep.run).not.toContain("gh pr checks");
  expect(mergeStep.if).toBeUndefined();
});

test.each(["unchanged", "changed", "added", "deleted"])(
  "the release CI docs gate handles %s generated pages",
  async (change) => {
    const workflow = parse(await readFile(path.join(rootDir, ".github/workflows/ci.yml"), "utf8"));
    const gate = workflow.jobs.ci.steps.find(
      (step) => step.name === "Verify the release API reference is current",
    );
    expect(gate.if).toContain("github.head_ref == 'release-please--branches--main'");
    expect(gate.run).toContain("pnpm run docs");

    const directory = await tempDir();
    const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
    git("init", "--quiet");
    await writeFile(path.join(directory, ".gitignore"), "docs/api/\n");
    await mkdir(path.join(directory, "docs/api"), { recursive: true });
    const page = path.join(directory, "docs/api/index.md");
    await writeFile(page, "Released reference\n");
    git("add", "-f", ".gitignore", "docs/api");
    git(
      "-c",
      "user.name=Docs test",
      "-c",
      "user.email=docs@example.com",
      "commit",
      "-qm",
      "Release",
    );

    if (change === "changed") await writeFile(page, "Next release reference\n");
    if (change === "added") {
      await writeFile(path.join(directory, "docs/api/new-entry.md"), "New API\n");
    }
    if (change === "deleted") await rm(page);

    // Rendering is exercised above; run the actual workflow's Git guard
    // against tracked changes and ignored new files in an isolated checkout.
    const check = () =>
      execFileSync("bash", ["-e", "-c", gate.run.replace("pnpm run docs", "true")], {
        cwd: directory,
        stdio: "pipe",
      });
    if (change === "unchanged") expect(check).not.toThrow();
    else expect(check).toThrow();
  },
);

test("the website covers the public entries, llms.txt and the favicon inside the Pages subpath", async () => {
  const destination = await tempDir();
  // Run the real build in Node so VitePress uses its own Vite version,
  // independently of Vitest's module loader.
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { renderSite } from ${JSON.stringify(new URL("./docs.mjs", import.meta.url).href)}; await renderSite(${JSON.stringify(destination)});`,
    ],
    { cwd: rootDir, stdio: "pipe" },
  );
  const manifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  const generated = await readdir(destination, { recursive: true });
  const files = new Set(generated);
  expect(files.has("index.html")).toBe(true);
  expect(files.has("api/index.html")).toBe(true);
  expect(files.has("guide/getting-started.html")).toBe(true);
  const modulePages = generated.filter(
    (file) => file.startsWith("api/") && file.endsWith(".html") && file !== "api/index.html",
  );
  const publicSubpaths = Object.keys(manifest.exports).filter((subpath) =>
    isPublicEntry({ subpath }),
  );
  expect(modulePages.sort()).toEqual(
    [
      ...publicSubpaths.map((subpath) =>
        subpath === "." ? "api/jigs.html" : `api/${subpath.slice(2)}.html`,
      ),
      "api/factory/routines.html",
      "api/factory/steps.html",
    ].sort(),
  );

  const llms = await readFile(path.join(destination, "llms.txt"), "utf8");
  expect(llms).toContain("https://salimhamed.github.io/jigs/guide/getting-started.md");
  expect(llms).toContain("https://salimhamed.github.io/jigs/api/steps/agents.md");
  expect(llms).toContain("/jigs/guide/waiting-and-events.md");
  expect(llms).toContain("/jigs/api/factory/routines.md");
  expect(llms).toContain("/jigs/api/factory/steps.md");
  expect(llms).not.toContain("steps/human");
  expect(llms.indexOf("guide/getting-started.md")).toBeLessThan(llms.indexOf("guide/why-jigs.md"));
  expect(llms.indexOf("guide/models-and-harnesses.md")).toBeLessThan(
    llms.indexOf("guide/waiting-and-events.md"),
  );
  expect(llms).not.toMatch(/salimhamed\.github\.io\/(?!jigs\/)/);
  const llmsFull = await readFile(path.join(destination, "llms-full.txt"), "utf8");
  expect(llmsFull).toContain("# steps/agents");

  const landing = await readFile(path.join(destination, "index.html"), "utf8");
  expect(landing).toContain(`v${manifest.version}`);
  expect(landing).toContain("VPHomeHero");
  expect(landing).toContain('<link rel="icon" type="image/svg+xml" href="/jigs/favicon.svg">');
  expect(files.has("favicon.svg")).toBe(true);
  expect(landing).toContain("Search");
  expect(generated.some((file) => /assets\/.*localSearchIndex.*\.js$/.test(file))).toBe(true);
  for (const file of generated.filter((file) => file.endsWith(".html"))) {
    const html = await readFile(path.join(destination, file), "utf8");
    for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(href)) continue;
      if (href.startsWith("/")) {
        expect(href, `${file}: ${href} must stay inside the Pages project`).toMatch(/^\/jigs\//);
      }
      const target = decodeURIComponent(href.split(/[?#]/)[0]);
      if (!target) continue;
      const relative = target.startsWith("/jigs/")
        ? target.slice("/jigs/".length)
        : path.normalize(path.join(path.dirname(file), target));
      if (!relative || relative.endsWith("/")) {
        expect(files.has(`${relative}index.html`), `${file}: missing ${href}`).toBe(true);
        continue;
      }
      expect(files.has(relative), `${file}: missing ${href}`).toBe(true);
    }
  }
}, 60_000);
