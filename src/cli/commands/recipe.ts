import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { addWorkflow, workflowEntry } from "../../config/config-edit.ts";
import { FACTORY_CONFIG_FILE } from "../../config/factory-config.ts";
import { JigsError } from "../../errors.ts";
import { copyFiles, reportCopied } from "../copy-files.ts";
import { packageRoot } from "../templates.ts";

const recipesRoot = () => path.join(packageRoot(), "recipes");

export function recipeNames(): string[] {
  return readdirSync(recipesRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function addRecipe(name: string, deps: { cwd: string; out: (line: string) => void }) {
  if (!recipeNames().includes(name)) {
    throw new JigsError(`unknown recipe: ${name}`, "pnpm exec jigs recipe list");
  }
  const root = path.resolve(deps.cwd);
  const configFile = path.join(root, FACTORY_CONFIG_FILE);
  if (!existsSync(configFile)) {
    throw new JigsError(
      "no jigs.config.ts in this directory",
      "run from a factory root, or pnpm exec jigs init first",
    );
  }
  // Parse before copying, so a config jigs cannot edit leaves the factory untouched.
  const registered = addWorkflow(readFileSync(configFile, "utf8"), name);
  const result = copyFiles(path.join(recipesRoot(), name), root, {
    suffix: "",
    contents: (source) => source,
  });
  reportCopied(result, deps.out);
  const entry = workflowEntry(name).slice(0, -1);
  if (registered === undefined) {
    deps.out(`${name} is already registered in ${FACTORY_CONFIG_FILE}`);
  } else {
    writeFileSync(configFile, registered);
    deps.out(`registered ${name} in ${FACTORY_CONFIG_FILE} by adding ${entry}`);
  }
  deps.out("");
  deps.out("next:");
  deps.out(
    `  pnpm exec jigs up       # build and restart with ${name}; doctor lists what it still needs`,
  );
  return result;
}
