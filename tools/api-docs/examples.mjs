import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { apiEntries, rootDir } from "./docs.mjs";

/** Read the code readers see, preserving its original line numbers. */
export function examplesIn(source, file) {
  const markdown = /\.md(?:\.tmpl)?$/.test(file)
    ? source
    : source.replace(/\/\*\*[\s\S]*?\*\//g, (comment) =>
        comment.includes("@example")
          ? comment.replace(/^\s*\* ?/gm, "")
          : comment.replace(/[^\n]/g, " "),
      );
  return [...markdown.matchAll(/^```(?:ts|typescript)([^\n]*)\n([\s\S]*?)^```/gm)].map((match) => ({
    file,
    line: markdown.slice(0, match.index).split("\n").length + 1,
    code: match[2],
    fragment: match[1].trim() === "factory-options",
    filename: /^\/\/ ([\w./-]+\.ts)\s*\n/.exec(match[2])?.[1],
  }));
}

async function filesUnder(directory) {
  const entries = await readdir(path.join(rootDir, directory), { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const name = path.join(directory, entry.name);
        return entry.isDirectory() ? filesUnder(name) : [name];
      }),
    )
  ).flat();
}

export async function documentationExamples() {
  const files = [
    "README.md",
    ...(await readdir(path.join(rootDir, "site")))
      .filter((file) => file.endsWith(".md"))
      .map((file) => path.join("site", file)),
    ...(await filesUnder("site/guide")).filter((file) => file.endsWith(".md")),
    ...(await filesUnder("skills")).filter((file) => file.endsWith(".md")),
    ...(await filesUnder("recipes")).filter((file) => file.endsWith(".md")),
    ...(await filesUnder("src")).filter((file) => file.endsWith(".ts")),
    ...(await filesUnder("templates")).filter((file) => file.endsWith(".tmpl")),
  ];
  return (
    await Promise.all(
      files.map(async (file) => examplesIn(await readFile(path.join(rootDir, file), "utf8"), file)),
    )
  ).flat();
}

/** Type-check isolated examples against the same modules a factory imports. */
export async function checkExamples(examples) {
  const virtualRoot = path.join(rootDir, ".docs-examples");
  const virtual = new Map();
  const locations = new Map();
  const manifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  const { default: build } = await import(path.join(rootDir, "tsdown.config.ts"));
  const entries = apiEntries(manifest, build.entry);
  const factoryConfig = JSON.parse(
    await readFile(path.join(rootDir, "templates/tsconfig.json.tmpl"), "utf8"),
  );
  const { options, errors } = ts.convertCompilerOptionsFromJson(
    factoryConfig.compilerOptions,
    rootDir,
  );
  if (errors.length)
    throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, diagnosticHost));
  options.moduleDetection = ts.ModuleDetectionKind.Force;
  options.paths = Object.fromEntries(
    entries.map((entry) => [
      entry.subpath === "." ? "@jigs-ai/jigs" : `@jigs-ai/jigs/${entry.subpath.slice(2)}`,
      [path.join(rootDir, entry.source)],
    ]),
  );
  options.paths["#jigs/*"] = [path.join(virtualRoot, "factory/jigs/*.ts")];
  for (const name of ["steps", "routines"]) {
    virtual.set(
      path.join(virtualRoot, `factory/jigs/${name}.ts`),
      await readFile(path.join(rootDir, `templates/jigs/${name}.ts.tmpl`), "utf8"),
    );
  }

  // These dependencies are real displayed files or scaffold files, never declarations
  // of missing variables. Each example still has to import everything it uses.
  const guides = await documentationExamples();
  const configuration = guides.find((example) => example.file === "site/guide/configuration.md");
  virtual.set(path.join(virtualRoot, "factory/jigs.config.ts"), configuration.code);
  const hello = await readFile(
    path.join(rootDir, "templates/workflows/hello/hello.ts.tmpl"),
    "utf8",
  );
  virtual.set(path.join(virtualRoot, "factory/workflows/hello/hello.ts"), hello);
  const triage = guides.find((example) => example.filename === "workflows/triage/triage.ts");
  if (triage) virtual.set(path.join(virtualRoot, "factory", triage.filename), triage.code);

  for (const [index, example] of examples.entries()) {
    const directory = path.join(virtualRoot, `example-${index}`);
    for (const other of guides.filter((other) => other.file === example.file && other.filename)) {
      virtual.set(path.join(directory, other.filename), other.code);
    }
    virtual.set(path.join(directory, "workflows/hello/hello.ts"), hello);
    if (triage) virtual.set(path.join(directory, triage.filename), triage.code);
    if (example.file.startsWith("recipes/")) {
      const recipeDirectory = path.dirname(example.file);
      for (const file of (await filesUnder(recipeDirectory)).filter((file) =>
        file.endsWith(".ts"),
      )) {
        virtual.set(
          path.join(directory, path.relative(recipeDirectory, file)),
          await readFile(path.join(rootDir, file), "utf8"),
        );
      }
    }
    const filename = path.join(
      directory,
      path.dirname(example.filename ?? "example.ts"),
      "example.ts",
    );
    virtual.set(
      filename,
      example.fragment
        ? `({\n${example.code}\n} satisfies Partial<import("@jigs-ai/jigs").FactoryDefinition>);\n`
        : example.code,
    );
    locations.set(filename, example);
  }

  const host = ts.createCompilerHost(options);
  const read = host.readFile;
  const exists = host.fileExists;
  const directoryExists = host.directoryExists;
  host.readFile = (file) => virtual.get(file) ?? read(file);
  host.fileExists = (file) => virtual.has(file) || exists(file);
  host.directoryExists = (directory) =>
    [...virtual.keys()].some((file) => file.startsWith(`${directory}/`)) ||
    directoryExists(directory);
  host.getSourceFile = (file, languageVersion) => {
    const text = host.readFile(file);
    return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion);
  };
  const program = ts.createProgram([...locations.keys()], options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (!diagnostic.file) return message;
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    const example = locations.get(diagnostic.file.fileName);
    if (example) {
      const line = example.line + position.line - Number(example.fragment);
      return `${example.file}:${line}:${position.character + 1}: ${message}`;
    }
    return `${path.relative(rootDir, diagnostic.file.fileName)}:${position.line + 1}: ${message}`;
  });
}

const diagnosticHost = {
  getCanonicalFileName: (file) => file,
  getCurrentDirectory: () => rootDir,
  getNewLine: () => "\n",
};

export async function checkDocumentationExamples() {
  const examples = await documentationExamples();
  if (!examples.length) throw new Error("No TypeScript documentation examples found");
  const errors = await checkExamples(examples);
  if (errors.length) throw new Error(errors.join("\n"));
  return examples.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkDocumentationExamples().then(
    (count) => console.log(`Checked ${count} TypeScript documentation examples.`),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
