import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { packageRoot } from "../../build/templates.ts";
import { addWorkflow, bindingNames, workflowEntry } from "../../config/config-edit.ts";
import { JigsError } from "../../errors.ts";
import { FACTORY_CONFIG_FILE } from "../../workflow/factory-schema.ts";
import { copyFiles, reportCopied } from "../copy-files.ts";
import { command, heading, note } from "../output.ts";

const recipesRoot = () => path.join(packageRoot(), "recipes");

// A recipe that runs from a trigger ships the entry beside its directory, so it
// is printed for the factory to fill in rather than copied with the workflow.
function triggerEntry(name: string, config: string): string[] | undefined {
  const file = path.join(recipesRoot(), `${name}.trigger.txt`);
  if (!existsSync(file)) return undefined;
  const bindings = bindingNames(config);
  const binding =
    bindings.length === 1
      ? JSON.stringify(bindings[0])
      : `"<${bindings.length === 0 ? "a binding" : `one of ${bindings.join(", ")}`}>"`;
  return readFileSync(file, "utf8").trimEnd().replace("{{binding}}", binding).split("\n");
}

export function recipeNames(): string[] {
  return readdirSync(recipesRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function addRecipe(name: string, deps: { cwd: string; out: (line: string) => void }) {
  if (!recipeNames().includes(name)) {
    throw new JigsError(
      `unknown recipe: ${name}`,
      "list the recipes: `pnpm exec jigs recipe list`",
    );
  }
  const root = path.resolve(deps.cwd);
  const configFile = path.join(root, FACTORY_CONFIG_FILE);
  if (!existsSync(configFile)) {
    throw new JigsError(
      "no jigs.config.ts in this directory",
      "run it from a factory root, or scaffold one first: `pnpm exec jigs init`",
    );
  }
  // Parse before copying, so a config jigs cannot edit leaves the factory untouched.
  const config = readFileSync(configFile, "utf8");
  const registered = addWorkflow(config, name);
  // A recipe directory is exactly what the factory receives at workflows/<name>/.
  const directory = path.join("workflows", name);
  const copied = copyFiles(path.join(recipesRoot(), name), path.join(root, directory), {
    suffix: "",
    contents: (source) => source,
  });
  const result = {
    created: copied.created.map((file) => path.join(directory, file)),
    skipped: copied.skipped.map((file) => path.join(directory, file)),
  };
  reportCopied(result, deps.out);
  const entry = workflowEntry(name).slice(0, -1);
  if (registered === undefined) {
    deps.out(`${name} is already registered in ${FACTORY_CONFIG_FILE}`);
  } else {
    writeFileSync(configFile, registered);
    deps.out(`registered ${name} in ${FACTORY_CONFIG_FILE} by adding ${entry}`);
  }
  deps.out("");
  deps.out(heading("Next"));
  const trigger = triggerEntry(name, config);
  if (trigger !== undefined) {
    deps.out(`  ${note(`add this to triggers in ${FACTORY_CONFIG_FILE}`)}`);
    for (const line of trigger) deps.out(`    ${line}`);
  }
  deps.out(
    `  ${command("pnpm exec jigs up")}  ${note(`# build and restart with ${name}, then doctor lists what it still needs`)}`,
  );
  return result;
}
