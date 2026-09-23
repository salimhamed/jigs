import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Application, ReflectionKind } from "typedoc";
import { typedocOptions } from "./typedoc.config.mjs";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(toolDir, "../..");

export function apiEntries(manifest, buildEntries) {
  return Object.entries(manifest.exports).map(([subpath, conditions]) => {
    if (!conditions || typeof conditions !== "object") {
      throw new Error(`${subpath}: exports entry must provide types and default conditions`);
    }
    const typesTarget = conditions.types;
    const match = /^\.\/dist\/(.+)\.d\.ts$/.exec(typesTarget ?? "");
    if (!match) throw new Error(`${subpath}: invalid types target ${String(typesTarget)}`);
    const buildKey = match[1];
    if (conditions.default !== `./dist/${buildKey}.js`) {
      throw new Error(`${subpath}: types and default targets do not share a build entry`);
    }
    const source = buildEntries[buildKey];
    if (!source) throw new Error(`${subpath}: no tsdown entry emits ${buildKey}`);
    return {
      subpath,
      source,
      output: subpath === "." ? "index.md" : `${subpath.slice(2)}.md`,
    };
  });
}

async function walkTypeScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkTypeScriptFiles(target)));
    else if (entry.name.endsWith(".ts")) files.push(target);
  }
  return files;
}

export function internalReferences(source, file = "source.ts") {
  const findings = [];
  for (const comment of source.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    const patterns = [
      ["Linear ticket", /\b[A-Z][A-Z0-9]+-\d+\b/g],
      ["ADR number", /\bADR[\s_-]*#?\d+\b/gi],
      ["ADR path", /\bdocs\/adr\/[A-Za-z0-9_/-]+(?:\.[A-Za-z0-9_-]+)*/gi],
    ];
    for (const [kind, pattern] of patterns) {
      for (const match of comment[0].matchAll(pattern)) {
        const offset = (comment.index ?? 0) + (match.index ?? 0);
        const line = source.slice(0, offset).split("\n").length;
        findings.push(`${file}:${line}: doc comment contains ${kind} ${JSON.stringify(match[0])}`);
      }
    }
  }
  return findings;
}

export function hasPackageDocumentation(source) {
  return /^\s*\/\*\*[\s\S]*?\*\//.exec(source)?.[0].includes("@packageDocumentation") ?? false;
}

function hasSummary(reflection) {
  const target = reflection.isReference() ? reflection.getTargetReflectionDeep() : reflection;
  const comments = [
    target.comment,
    ...(target.signatures ?? []).map((signature) => signature.comment),
  ];
  return comments.some((comment) => comment?.summary?.some((part) => part.text.trim().length > 0));
}

/** Return directly exported declarations that do not have a summary. */
export function directExportSummaryFailures(project) {
  const modules = project.children?.every((child) => child.kindOf(ReflectionKind.Module))
    ? project.children
    : [project];
  return modules.flatMap((module) =>
    (module.children ?? [])
      .filter((reflection) => !hasSummary(reflection))
      .map((reflection) => `${module === project ? project.name : module.name}.${reflection.name}`),
  );
}

/** Require a summary on every declaration exported directly from an entry point. */
export function assertDirectExportSummaries(project) {
  const undocumented = directExportSummaryFailures(project);
  if (undocumented.length) {
    throw new Error(
      `Direct exports missing a summary:\n${undocumented.map((name) => `- ${name}`).join("\n")}`,
    );
  }
}

async function repositoryConfig() {
  const manifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  const { default: buildConfig } = await import(path.join(rootDir, "tsdown.config.ts"));
  return {
    manifest,
    entries: apiEntries(manifest, buildConfig.entry),
  };
}

async function checkRepositoryRules(entries) {
  const failures = [];
  for (const entry of entries) {
    const source = await readFile(path.join(rootDir, entry.source), "utf8");
    if (!hasPackageDocumentation(source)) {
      failures.push(`${entry.source}: missing a leading @packageDocumentation comment`);
    }
  }
  for (const directory of ["src", "recipes/ship"]) {
    for (const file of await walkTypeScriptFiles(path.join(rootDir, directory))) {
      const relative = path.relative(rootDir, file);
      failures.push(...internalReferences(await readFile(file, "utf8"), relative));
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

export async function convert(entryPoints, { format = "markdown", ...options } = {}) {
  const app = await Application.bootstrapWithPlugins({
    ...typedocOptions,
    entryPoints,
    name: "@jigs-ai/jigs",
    plugin:
      format === "vitepress"
        ? ["typedoc-plugin-markdown", "typedoc-vitepress-theme"]
        : ["typedoc-plugin-markdown"],
    tsconfig: path.join(rootDir, "tsconfig.json"),
    ...options,
  });
  const project = await app.convert();
  if (!project || app.logger.hasErrors()) throw new Error("TypeDoc conversion failed");
  return { app, project };
}

async function validate(entries) {
  await checkRepositoryRules(entries);
  const { app, project } = await convert(entries.map((entry) => path.join(rootDir, entry.source)));
  app.validate(project);
  assertDirectExportSummaries(project);
  if (app.logger.hasErrors() || app.logger.hasWarnings()) {
    throw new Error("TypeDoc validation failed");
  }
}

export async function renderEntry(entry, destination) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "jigs-api-docs-"));
  try {
    const { app, project } = await convert([path.join(rootDir, entry.source)], {
      validation: typedocOptions.validation,
    });
    await app.outputs.writeOutput({ name: "markdown", path: temporary }, project);
    if (app.logger.hasErrors() || app.logger.hasWarnings()) {
      throw new Error(`TypeDoc rendering failed for ${entry.subpath}`);
    }
    const generated = await readdir(temporary);
    if (generated.length !== 1 || generated[0] !== "index.md") {
      throw new Error(
        `${entry.subpath}: expected one generated index.md, found ${generated.join(", ")}`,
      );
    }
    const target = path.join(destination, entry.output);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(temporary, "index.md"), target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function run({ write = false, destination = path.join(rootDir, "docs/api") } = {}) {
  const { entries } = await repositoryConfig();
  await validate(entries);
  if (!write) return;
  await rm(destination, { recursive: true, force: true });
  await Promise.all(entries.map((entry) => renderEntry(entry, destination)));
}

export async function renderSite(destination = path.join(rootDir, "docs-site")) {
  const { entries } = await repositoryConfig();
  await checkRepositoryRules(entries);
  const { app, project } = await convert(
    entries.map((entry) => path.join(rootDir, entry.source)),
    {
      format: "vitepress",
      docsRoot: path.join(rootDir, "site"),
      out: path.join(rootDir, "site/api"),
      sidebar: { collapsed: true },
    },
  );
  app.validate(project);
  assertDirectExportSummaries(project);
  if (app.logger.hasErrors() || app.logger.hasWarnings()) {
    throw new Error("TypeDoc validation failed");
  }
  await app.outputs.writeOutput(
    { name: "markdown", path: path.join(rootDir, "site/api") },
    project,
  );
  if (app.logger.hasErrors() || app.logger.hasWarnings()) {
    throw new Error("TypeDoc site rendering failed");
  }
  const { build } = await import("vitepress");
  await build(path.join(rootDir, "site"), { outDir: destination });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const operation = process.argv.includes("--site")
    ? renderSite()
    : run({ write: !process.argv.includes("--check") });
  operation.catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
